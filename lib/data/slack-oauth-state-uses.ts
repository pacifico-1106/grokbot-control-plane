/**
 * Single-use record for signed Slack OAuth states (shared approval app install).
 * Only sha256(nonce) is stored. A second use of the same state is refused even
 * if the browser still holds the nonce cookie. Fails closed when the store is
 * unavailable.
 */
import { createHash } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

const demoUsed = new Map<string, number>();

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export function resetDemoSlackOAuthStateUses(): void {
  demoUsed.clear();
}

/** true = first use (now recorded); false = already used or could not record. */
export async function consumeSlackOAuthStateNonce(input: {
  purpose: string;
  nonce: string;
  orgId: string;
  expiresAtMs: number;
}): Promise<boolean> {
  const nonce = (input.nonce || "").trim();
  if (!nonce || !/^[a-z0-9_]{1,64}$/.test(input.purpose)) return false;
  const key = hashNonce(nonce);
  if (isDemoMode()) {
    if (demoUsed.has(key)) return false;
    demoUsed.set(key, input.expiresAtMs);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { error } = await admin.from("slack_oauth_state_uses").insert({
    nonce_hash: key,
    purpose: input.purpose,
    org_id: input.orgId,
    expires_at: new Date(input.expiresAtMs).toISOString(),
  });
  return !error;
}
