/**
 * Single-use record for signed Slack OAuth states (shared approval app install).
 * Only sha256(nonce) is stored. A second use of the same state is refused even
 * if the browser still holds the nonce cookie. Fails closed when the store is
 * unavailable.
 *
 * Cleanup (review 3): opportunistic, on write. Each consume first deletes rows
 * whose expires_at is older than SLACK_OAUTH_STATE_USE_RETENTION_MS. Safe
 * because the signed state itself expires (10 min) and is rejected by state
 * verification BEFORE this table is consulted, so dropping a long-expired row
 * can never re-open a replay. Installs are rare, so no cron / secret / route
 * is added. A cleanup failure is ignored (it never blocks or allows a consume).
 */
import { createHash } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

/** Rows are kept this long after their state expired (≥ the 10 min state TTL). */
export const SLACK_OAUTH_STATE_USE_RETENTION_MS = 60 * 60_000;

const demoUsed = new Map<string, number>();

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export function resetDemoSlackOAuthStateUses(): void {
  demoUsed.clear();
}

export function demoSlackOAuthStateUseCountForTests(): number {
  return demoUsed.size;
}

function pruneDemo(nowMs: number): void {
  const cutoff = nowMs - SLACK_OAUTH_STATE_USE_RETENTION_MS;
  for (const [key, expiresAtMs] of demoUsed) {
    if (expiresAtMs < cutoff) demoUsed.delete(key);
  }
}

/** true = first use (now recorded); false = already used or could not record. */
export async function consumeSlackOAuthStateNonce(input: {
  purpose: string;
  nonce: string;
  orgId: string;
  expiresAtMs: number;
  /** Tests only. */
  nowMs?: number;
}): Promise<boolean> {
  const nonce = (input.nonce || "").trim();
  if (!nonce || !/^[a-z0-9_]{1,64}$/.test(input.purpose)) return false;
  const key = hashNonce(nonce);
  const nowMs = input.nowMs ?? Date.now();
  if (isDemoMode()) {
    pruneDemo(nowMs);
    if (demoUsed.has(key)) return false;
    demoUsed.set(key, input.expiresAtMs);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    await admin
      .from("slack_oauth_state_uses")
      .delete()
      .lt("expires_at", new Date(nowMs - SLACK_OAUTH_STATE_USE_RETENTION_MS).toISOString());
  } catch {
    // best effort
  }
  const { error } = await admin.from("slack_oauth_state_uses").insert({
    nonce_hash: key,
    purpose: input.purpose,
    org_id: input.orgId,
    expires_at: new Date(input.expiresAtMs).toISOString(),
  });
  return !error;
}
