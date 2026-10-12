/**
 * Link-code brute-force guard (design §5 連携コードの総当たり, hole H8).
 *
 * A link code (#228, SP-XXXX-XXXX) is the proof that a LINE user is a Staffpass
 * member; in conversations it decides "internal". So:
 *   (1) per sending LINE userId: 5 wrong codes in 15 min → refused for 1 hour
 *   (2) per account / channel:   30 wrong codes in 1 hour → refused for 1 hour,
 *       and ops are alerted once (IDs and reason only)
 *   (3) one reply for every refusal (wrong, expired, locked) — it never tells
 *       whether a code exists
 *   (4)/(5) 1:1 only and self-issued codes only are enforced by the caller (#228)
 * Counts live in the DB (comm_link_code_gate / comm_link_code_record_failure),
 * not per server instance. The gate runs BEFORE the code is looked up, so a
 * locked sender cannot use even a right code. A storage error refuses (fail
 * closed) and is not counted as a wrong code.
 *
 * The sending userId is stored only as a keyed HMAC (VOTER_BINDING_SECRET,
 * the key #228's link codes already use); no key → fail closed.
 */
import { createHmac } from "node:crypto";

export const LINK_CODE_FAILURE_REPLY_JA =
  "連携コードを確認できませんでした。Staffpass の設定画面で新しいコードを発行して、しばらくしてからもう一度送ってください。";

export type LinkCodeGate = "ok" | "sender_locked" | "account_locked";
export type LinkCodeRecord = "recorded" | "sender_locked" | "account_locked" | "account_locked_new";

export type LinkCodeGuardBackend = {
  gate(orgId: string, accountKey: string, senderKey: string): Promise<LinkCodeGate>;
  recordFailure(orgId: string, accountKey: string, senderKey: string): Promise<LinkCodeRecord>;
  alertOps(payload: { orgId: string; accountKey: string; reason: "link_code_account_locked" }): Promise<void>;
};

export type LinkCodeAttempt<T> = { ok: true; value: T } | { ok: false; reason: string };
export type GuardedResult<T> = { ok: true; value: T } | { ok: false; replyJa: string; reason: string };

/** Reasons from the code lookup that mean "a wrong code" (counted). Others are storage errors. */
const WRONG_CODE_REASONS = new Set(["invalid_or_expired", "wrong_channel", "already_used"]);

export function linkCodeSenderKey(orgId: string, lineUserId: string): string {
  const secret = process.env.VOTER_BINDING_SECRET?.trim() || "";
  if (secret.length < 32) throw new Error("link_code_guard_key_missing");
  return createHmac("sha256", secret).update(`link_code_sender:${orgId}:${lineUserId}`, "utf8").digest("hex");
}

export async function withLinkCodeGuard<T>(
  backend: LinkCodeGuardBackend,
  input: { orgId: string; accountKey: string; lineUserId: string },
  attempt: () => Promise<LinkCodeAttempt<T>>
): Promise<GuardedResult<T>> {
  let senderKey: string;
  let gate: LinkCodeGate;
  try {
    senderKey = linkCodeSenderKey(input.orgId, input.lineUserId);
    gate = await backend.gate(input.orgId, input.accountKey, senderKey);
  } catch {
    return { ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: "guard_unavailable" };
  }
  if (gate !== "ok") return { ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: gate };
  const result = await attempt();
  if (result.ok) return result;
  if (WRONG_CODE_REASONS.has(result.reason)) {
    try {
      const recorded = await backend.recordFailure(input.orgId, input.accountKey, senderKey);
      if (recorded === "account_locked_new") {
        await backend
          .alertOps({ orgId: input.orgId, accountKey: input.accountKey, reason: "link_code_account_locked" })
          .catch(() => undefined);
      }
    } catch {
      // the refusal stands; a lost count is logged, never turned into an accept
      console.error("link_code_failure_record_failed", { orgId: input.orgId, accountKey: input.accountKey });
    }
  }
  return { ok: false, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason: result.reason };
}

/** Supabase backend: the two SQL functions of migration 20261013200000 + ops alert. */
export async function supabaseLinkCodeGuardBackend(): Promise<LinkCodeGuardBackend | null> {
  const { createSupabaseAdminClient } = await import("@/lib/supabase");
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  return {
    async gate(orgId, accountKey, senderKey) {
      const { data, error } = await admin.rpc("comm_link_code_gate", {
        p_org_id: orgId,
        p_account_key: accountKey,
        p_sender_key: senderKey,
      });
      if (error) throw new Error("link_code_gate_failed");
      if (data !== "ok" && data !== "sender_locked" && data !== "account_locked") throw new Error("link_code_gate_bad_result");
      return data;
    },
    async recordFailure(orgId, accountKey, senderKey) {
      const { data, error } = await admin.rpc("comm_link_code_record_failure", {
        p_org_id: orgId,
        p_account_key: accountKey,
        p_sender_key: senderKey,
      });
      if (error) throw new Error("link_code_record_failed");
      return data as LinkCodeRecord;
    },
    alertOps: notifyOpsLinkCodeAccountLocked,
  };
}

const OPS_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Ops only, IDs and reason only (no LINE userId, no code). Never throws. */
export async function notifyOpsLinkCodeAccountLocked(p: { orgId: string; accountKey: string; reason: "link_code_account_locked" }) {
  const line = `連携コードの間違いが 1 時間に 30 回を超えたため、この窓口の連携コードの受付を 1 時間止めました（org ${p.orgId} / 窓口 ${p.accountKey}）。`;
  const todo = "対処: 総当たりの疑いがあります。テナントに心当たりを確認し、必要なら窓口を無効にしてください。";
  try {
    const { appendAuditEvent } = await import("@/lib/data/audit");
    const meta = { auditClass: "admin", event: "comm.link_code_account_locked", targetOrgId: p.orgId, accountKey: p.accountKey, reason: p.reason };
    await appendAuditEvent({ orgId: p.orgId, employeeId: null, credentialId: null, action: "comm.link_code_account_locked", purpose: null, summary: line, metadata: meta }).catch(() => undefined);
    const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
    if (opsOrgId && opsOrgId !== p.orgId) {
      await appendAuditEvent({ orgId: opsOrgId, employeeId: null, credentialId: null, action: "comm.link_code_account_locked", purpose: null, summary: line, metadata: meta }).catch(() => undefined);
    }
    const to = (process.env.APPROVAL_ALERT_OPS_EMAILS || "").split(",").map((s) => s.trim()).filter((s) => OPS_EMAIL_RE.test(s)).slice(0, 10);
    if (to.length) {
      const { sendTransactionalEmail } = await import("@/lib/resend");
      await sendTransactionalEmail({
        to,
        template: "oauth_security",
        subject: "【運営】LINE: 連携コードの総当たりの疑い",
        html: `<p>${line}</p><p>${todo}</p>`,
        text: `${line}\n${todo}`,
        tags: [{ name: "template", value: "comm_link_code_locked" }],
      }).catch(() => undefined);
    }
  } catch {
    console.warn("comm_link_code_account_locked", { orgId: p.orgId, accountKey: p.accountKey });
  }
}
