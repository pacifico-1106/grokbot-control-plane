/**
 * LINE approver link codes (連携コード) — G1 + G4.
 *
 * Proof model: a logged-in Staffpass member with approval rights issues a short single-use code for themselves
 * for ONE LINE approval channel. Sending that exact code to the channel's LINE
 * Official Account in a 1:1 chat proves that the same person controls both the
 * Staffpass session (→ member) and the LINE account (→ source.userId, which the
 * webhook trusts only after the channel-secret signature check).
 *
 * Invariants:
 * - Codes are stored as keyed HMAC hashes (VOTER_BINDING_SECRET); the plaintext
 *   is returned once to the issuer and never logged or stored.
 * - Single use, 15-minute TTL, bound to (org_id, channel_id). A code issued for
 *   one tenant's channel cannot be redeemed through another channel's webhook.
 * - Issuing a new code invalidates the member's previous unused code.
 * - Missing secret in production → throws (callers fail closed).
 */
import { createHmac, randomBytes } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const LINE_LINK_CODE_TTL_MS = 15 * 60 * 1000;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 symbols, no 0/O/1/I
const CODE_LENGTH = 8; // 40 bits
const TABLE = "line_approver_link_codes";

export function resolveLinkCodeSecret(value: string | undefined, demo: boolean): string {
  if (demo) return value?.trim() || "dev-secret";
  const secret = value?.trim() || "";
  if (!secret || secret === "dev-secret") {
    throw new Error("VOTER_BINDING_SECRET must be configured in production");
  }
  return secret;
}

function secret(): string {
  return resolveLinkCodeSecret(process.env.VOTER_BINDING_SECRET, isDemoMode());
}

export function generateLineLinkCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function formatLineLinkCode(code: string): string {
  return `SP-${code.slice(0, 4)}-${code.slice(4)}`;
}

const CODE_TEXT_RE = /^SP-?([2-9A-HJ-NP-Z]{4})-?([2-9A-HJ-NP-Z]{4})$/;

/** Returns the normalized 8-symbol code when the WHOLE message is a link code. */
export function parseLineLinkCodeText(text: string | null | undefined): string | null {
  const normalized = String(text ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s]+/g, "-")
    .replace(/[‐-―−ー]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length > 16) return null;
  const match = CODE_TEXT_RE.exec(normalized.replace(/-+/g, "-"));
  return match ? `${match[1]}${match[2]}` : null;
}

export function hashLineLinkCode(code: string, key: string): string {
  return createHmac("sha256", key).update(`line-approver-link:v1:${code}`).digest("hex");
}

type DemoRow = {
  orgId: string;
  channelId: string;
  memberId: string;
  issuedByUserId: string | null;
  codeHash: string;
  expiresAt: number;
  consumedAt: number | null;
  invalidatedAt: number | null;
  lineUserId: string | null;
};
const demoRows: DemoRow[] = [];

export function resetDemoLineLinkCodes(): void {
  demoRows.length = 0;
}

export type IssueLineLinkCodeResult =
  | { ok: true; code: string; display: string; expiresAt: string }
  | { ok: false; reason: "secret_not_configured" | "storage_unavailable" | "issue_failed" };

export async function issueLineLinkCode(input: {
  orgId: string;
  channelId: string;
  memberId: string;
  issuedByUserId: string | null;
  now?: number;
}): Promise<IssueLineLinkCodeResult> {
  let key: string;
  try {
    key = secret();
  } catch {
    return { ok: false, reason: "secret_not_configured" };
  }
  const now = input.now ?? Date.now();
  const code = generateLineLinkCode();
  const codeHash = hashLineLinkCode(code, key);
  const expiresAt = now + LINE_LINK_CODE_TTL_MS;

  if (isDemoMode()) {
    for (const row of demoRows) {
      if (
        row.orgId === input.orgId && row.channelId === input.channelId && row.memberId === input.memberId &&
        row.consumedAt === null && row.invalidatedAt === null
      ) {
        row.invalidatedAt = now;
      }
    }
    demoRows.push({
      orgId: input.orgId,
      channelId: input.channelId,
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
    .from(TABLE)
    .update({ invalidated_at: nowIso })
    .eq("org_id", input.orgId)
    .eq("channel_id", input.channelId)
    .eq("member_id", input.memberId)
    .is("consumed_at", null)
    .is("invalidated_at", null);
  if (invalidateError) return { ok: false, reason: "issue_failed" };
  const { error } = await admin.from(TABLE).insert({
    org_id: input.orgId,
    channel_id: input.channelId,
    member_id: input.memberId,
    issued_by_user_id: input.issuedByUserId,
    code_hash: codeHash,
    expires_at: new Date(expiresAt).toISOString(),
    created_at: nowIso,
  });
  if (error) return { ok: false, reason: "issue_failed" };
  return { ok: true, code, display: formatLineLinkCode(code), expiresAt: new Date(expiresAt).toISOString() };
}

export type ConsumeLineLinkCodeResult =
  | { ok: true; memberId: string; issuedByUserId: string | null }
  | { ok: false; reason: "invalid_or_expired" | "secret_not_configured" | "storage_unavailable" };

/**
 * Atomically redeem a code for (org, channel). The conditional UPDATE is the
 * single-use guard: only one webhook delivery can flip consumed_at.
 */
export async function consumeLineLinkCode(input: {
  orgId: string;
  channelId: string;
  code: string;
  lineUserId: string;
  now?: number;
}): Promise<ConsumeLineLinkCodeResult> {
  let key: string;
  try {
    key = secret();
  } catch {
    return { ok: false, reason: "secret_not_configured" };
  }
  const now = input.now ?? Date.now();
  const codeHash = hashLineLinkCode(input.code, key);

  if (isDemoMode()) {
    const row = demoRows.find(
      (item) =>
        item.codeHash === codeHash && item.orgId === input.orgId && item.channelId === input.channelId &&
        item.consumedAt === null && item.invalidatedAt === null && item.expiresAt > now
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
    .from(TABLE)
    .update({ consumed_at: nowIso, line_user_id: input.lineUserId })
    .eq("code_hash", codeHash)
    .eq("org_id", input.orgId)
    .eq("channel_id", input.channelId)
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

/** Pending (unused, unexpired) code for the member — expiry only, never the code. */
export async function getPendingLineLinkCode(input: {
  orgId: string;
  channelId: string;
  memberId: string;
  now?: number;
}): Promise<{ expiresAt: string } | null> {
  const now = input.now ?? Date.now();
  if (isDemoMode()) {
    const row = demoRows
      .filter(
        (item) =>
          item.orgId === input.orgId && item.channelId === input.channelId && item.memberId === input.memberId &&
          item.consumedAt === null && item.invalidatedAt === null && item.expiresAt > now
      )
      .sort((a, b) => b.expiresAt - a.expiresAt)[0];
    return row ? { expiresAt: new Date(row.expiresAt).toISOString() } : null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from(TABLE)
    .select("expires_at")
    .eq("org_id", input.orgId)
    .eq("channel_id", input.channelId)
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
