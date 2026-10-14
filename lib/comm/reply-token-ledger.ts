/**
 * L-6: used LINE replyTokens and "unknown" send outcomes live in a ledger
 * (demo memory, or DB when Supabase is configured). Not per-process memory:
 * another instance must not Reply the same token (that would fall through to
 * Push and double-deliver). An "unknown" outcome is recorded so neither the
 * caller nor post-approval execution retries automatically — a resend is a
 * human decision.
 *
 * Flag LINE_CONVERSATION_ENABLED (needs COMM_ACCOUNTS_ENABLED). OFF → no writes.
 */
import { createHash } from "node:crypto";
import { isLineConversationEnabled } from "@/lib/comm/flags";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

function hashReplyToken(accountId: string, replyToken: string): string {
  return createHash("sha256").update(`line-reply-token:v1:${accountId}:${replyToken}`).digest("hex");
}

const demoUsed = new Map<string, number>();
const demoUnknown = new Map<string, number>();

export function __resetLineReplyTokenLedgerForTests(): void {
  demoUsed.clear();
  demoUnknown.clear();
}

export async function claimLineReplyToken(input: {
  orgId: string;
  accountId: string;
  replyToken: string;
}): Promise<{ ok: true; claimed: boolean } | { ok: false; reason: string }> {
  const rt = String(input.replyToken || "").trim();
  if (!rt || !input.orgId || !input.accountId) return { ok: false, reason: "invalid" };
  const key = hashReplyToken(input.accountId, rt);
  if (isDemoMode() || !isLineConversationEnabled()) {
    if (demoUsed.has(key)) return { ok: true, claimed: false };
    demoUsed.set(key, Date.now());
    return { ok: true, claimed: true };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "storage_unavailable" };
  const { error } = await admin.from("comm_line_reply_tokens").insert({
    token_hash: key,
    org_id: input.orgId,
    account_id: input.accountId,
    outcome: "used",
  });
  if (!error) return { ok: true, claimed: true };
  if ((error as { code?: string }).code === "23505") return { ok: true, claimed: false };
  return { ok: false, reason: "storage_error" };
}

export async function recordLineReplyUnknown(input: {
  orgId: string;
  accountId?: string;
  retryKey: string;
}): Promise<void> {
  const retry = String(input.retryKey || "").trim();
  if (!retry || !input.orgId) return;
  const key = `${input.orgId}:${retry}`;
  if (isDemoMode() || !isLineConversationEnabled()) {
    demoUnknown.set(key, Date.now());
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    demoUnknown.set(key, Date.now());
    return;
  }
  await admin.from("comm_line_send_unknown").upsert(
    { org_id: input.orgId, retry_key: retry, account_id: input.accountId || null },
    { onConflict: "org_id,retry_key" }
  ).then(() => undefined, () => undefined);
}

export async function wasLineReplyUnknown(input: { orgId: string; retryKey: string }): Promise<boolean> {
  const retry = String(input.retryKey || "").trim();
  if (!retry || !input.orgId) return false;
  const key = `${input.orgId}:${retry}`;
  if (demoUnknown.has(key)) return true;
  if (isDemoMode() || !isLineConversationEnabled()) return false;
  const admin = createSupabaseAdminClient();
  if (!admin) return demoUnknown.has(key);
  const { data } = await admin
    .from("comm_line_send_unknown")
    .select("retry_key")
    .eq("org_id", input.orgId)
    .eq("retry_key", retry)
    .maybeSingle();
  return Boolean(data);
}
