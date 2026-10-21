/**
 * Conversation link codes (L-7). Stored separately from approver codes so
 * channel_id is not written into line_approver_link_codes (FK to
 * org_notification_channels). account_id references employee_comm_accounts.
 */
import { createHmac } from "node:crypto";
import {
  formatLineLinkCode,
  generateLineLinkCode,
  LINE_LINK_CODE_TTL_MS,
  resolveLinkCodeSecret,
} from "@/lib/line/link-code";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

type DemoRow = {
  orgId: string;
  accountId: string;
  memberId: string;
  issuedByUserId: string | null;
  codeHash: string;
  expiresAt: number;
  consumedAt: number | null;
  invalidatedAt: number | null;
  lineUserId: string | null;
};
const demoRows: DemoRow[] = [];

export function resetDemoConversationLinkCodes(): void {
  demoRows.length = 0;
}

function secret(): string {
  return resolveLinkCodeSecret(process.env.VOTER_BINDING_SECRET, isDemoMode());
}

function hashConversationLinkCode(code: string, key: string): string {
  return createHmac("sha256", key).update(`line-conversation-link:v1:${code}`, "utf8").digest("hex");
}

export type IssueConversationLinkCodeResult =
  | { ok: true; code: string; display: string; expiresAt: string }
  | { ok: false; reason: "secret_not_configured" | "storage_unavailable" | "issue_failed" };

export async function issueConversationLinkCode(input: {
  orgId: string;
  accountId: string;
  memberId: string;
  issuedByUserId: string | null;
  now?: number;
}): Promise<IssueConversationLinkCodeResult> {
  let key: string;
  try {
    key = secret();
  } catch {
    return { ok: false, reason: "secret_not_configured" };
  }
  const now = input.now ?? Date.now();
  const code = generateLineLinkCode();
  const codeHash = hashConversationLinkCode(code, key);
  const expiresAt = now + LINE_LINK_CODE_TTL_MS;

  if (isDemoMode()) {
    for (const row of demoRows) {
      if (
        row.orgId === input.orgId &&
        row.accountId === input.accountId &&
        row.memberId === input.memberId &&
        row.consumedAt === null &&
        row.invalidatedAt === null
      ) {
        row.invalidatedAt = now;
      }
    }
    demoRows.push({
      orgId: input.orgId,
      accountId: input.accountId,
      memberId: input.memberId,
      issuedByUserId: input.issuedByUserId,
      codeHash,
      expiresAt,
      consumedAt: null,
      invalidatedAt: null,
      lineUserId: null,
    });
    return { ok: true, code, display: formatLineLinkCode(code), expiresAt: new Date(expiresAt).toISOString() };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "storage_unavailable" };
  const nowIso = new Date(now).toISOString();
  const { error: invalidateError } = await admin
    .from("line_conversation_link_codes")
    .update({ invalidated_at: nowIso })
    .eq("org_id", input.orgId)
    .eq("account_id", input.accountId)
    .eq("member_id", input.memberId)
    .is("consumed_at", null)
    .is("invalidated_at", null);
  if (invalidateError) return { ok: false, reason: "issue_failed" };
  const { error } = await admin.from("line_conversation_link_codes").insert({
    org_id: input.orgId,
    account_id: input.accountId,
    member_id: input.memberId,
    issued_by_user_id: input.issuedByUserId,
    code_hash: codeHash,
    expires_at: new Date(expiresAt).toISOString(),
    created_at: nowIso,
  });
  if (error) return { ok: false, reason: "issue_failed" };
  return { ok: true, code, display: formatLineLinkCode(code), expiresAt: new Date(expiresAt).toISOString() };
}

export async function consumeConversationLinkCode(input: {
  orgId: string;
  accountId: string;
  code: string;
  lineUserId: string;
  now?: number;
}): Promise<
  | { ok: true; memberId: string; issuedByUserId: string | null }
  | { ok: false; reason: "invalid_or_expired" | "secret_not_configured" | "storage_unavailable" }
> {
  let key: string;
  try {
    key = secret();
  } catch {
    return { ok: false, reason: "secret_not_configured" };
  }
  const now = input.now ?? Date.now();
  const codeHash = hashConversationLinkCode(input.code, key);

  if (isDemoMode()) {
    const row = demoRows.find(
      (item) =>
        item.codeHash === codeHash &&
        item.orgId === input.orgId &&
        item.accountId === input.accountId &&
        item.consumedAt === null &&
        item.invalidatedAt === null &&
        item.expiresAt > now
    );
    if (!row) return { ok: false, reason: "invalid_or_expired" };
    row.consumedAt = now;
    row.lineUserId = input.lineUserId;
    return { ok: true, memberId: row.memberId, issuedByUserId: row.issuedByUserId };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "storage_unavailable" };
  const nowIso = new Date(now).toISOString();
  const { data, error } = await admin
    .from("line_conversation_link_codes")
    .update({ consumed_at: nowIso, line_user_id: input.lineUserId })
    .eq("code_hash", codeHash)
    .eq("org_id", input.orgId)
    .eq("account_id", input.accountId)
    .is("consumed_at", null)
    .is("invalidated_at", null)
    .gt("expires_at", nowIso)
    .select("member_id, issued_by_user_id")
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "invalid_or_expired" };
  const row = data as { member_id?: unknown; issued_by_user_id?: unknown };
  return {
    ok: true,
    memberId: String(row.member_id || ""),
    issuedByUserId: row.issued_by_user_id ? String(row.issued_by_user_id) : null,
  };
}

export async function getPendingConversationLinkCode(input: {
  orgId: string;
  accountId: string;
  memberId: string;
  now?: number;
}): Promise<{ expiresAt: string } | null> {
  const now = input.now ?? Date.now();
  if (isDemoMode()) {
    const row = demoRows
      .filter(
        (item) =>
          item.orgId === input.orgId &&
          item.accountId === input.accountId &&
          item.memberId === input.memberId &&
          item.consumedAt === null &&
          item.invalidatedAt === null &&
          item.expiresAt > now
      )
      .sort((a, b) => b.expiresAt - a.expiresAt)[0];
    return row ? { expiresAt: new Date(row.expiresAt).toISOString() } : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("line_conversation_link_codes")
    .select("expires_at")
    .eq("org_id", input.orgId)
    .eq("account_id", input.accountId)
    .eq("member_id", input.memberId)
    .is("consumed_at", null)
    .is("invalidated_at", null)
    .gt("expires_at", new Date(now).toISOString())
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { expiresAt: new Date(String((data as { expires_at: unknown }).expires_at)).toISOString() };
}
