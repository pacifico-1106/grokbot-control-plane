/**
 * Link-code brute-force guard (design §5 連携コードの総当たり, hole H8).
 *
 * A link code (#228, SP-XXXX-XXXX) is the proof that a LINE user is a Staffpass
 * member; in conversations it decides "internal". So:
 *   (1) per sending LINE userId: 5 attempts in 15 min → the 6th refused, locked 1 hour
 *   (2) per account / channel:   30 attempts in 1 hour → the 31st locks it for 1 hour,
 *       ops alerted once per lock (IDs and reason only); the 3rd lock within 24 hours
 *       also tells the tenant's approvers (ops + approvers, once per 24 hours) — 木村 10/12
 *   (3) one reply for every refusal (wrong, expired, locked) — it never tells
 *       whether a code exists
 *   (4)/(5) 1:1 only and self-issued codes only are enforced by the caller (#228)
 * 木村 10/12 [MED]: ONE DB call (comm_link_code_reserve_attempt) checks the locks
 * AND reserves an attempt slot BEFORE the code is compared, so concurrent guesses
 * cannot all pass a separate check. A right code gives its slot back
 * (comm_link_code_release_attempt); a wrong one keeps it. A storage error of the
 * guard refuses (fail closed); a storage error of the code lookup gives the slot
 * back (not a wrong code).
 *
 * The sending userId is stored only as a keyed HMAC (VOTER_BINDING_SECRET,
 * the key #228's link codes already use); no key → fail closed.
 */
import { createHmac } from "node:crypto";

export const LINK_CODE_FAILURE_REPLY_JA =
  "連携コードを確認できませんでした。Staffpass の設定画面で新しいコードを発行して、しばらくしてからもう一度送ってください。";

export type LinkCodeReservation = {
  result: "ok" | "sender_locked" | "account_locked";
  /** set when result is "ok" */
  attemptId: string | null;
  /** set once, by the call that locked the account */
  notify: null | "account_locked" | "account_locked_repeat";
};

type AlertPayload<R extends string> = { orgId: string; accountKey: string; reason: R };
export type LinkCodeGuardBackend = {
  reserve(orgId: string, accountKey: string, senderKey: string): Promise<LinkCodeReservation>;
  release(orgId: string, attemptId: string): Promise<void>;
  alertOps(payload: AlertPayload<"link_code_account_locked">): Promise<void>;
  /** ops + the tenant's approvers: 3 account locks within 24 hours */
  alertRepeat(payload: AlertPayload<"link_code_account_locked_repeat">): Promise<void>;
};

export type LinkCodeAttempt<T> = { ok: true; value: T } | { ok: false; reason: string };
export type GuardedResult<T> = { ok: true; value: T } | { ok: false; replyJa: string; reason: string };

/** Reasons from the code lookup that mean "a wrong code" (slot kept). Others are storage errors. */
const WRONG_CODE_REASONS = new Set(["invalid_or_expired", "wrong_channel", "already_used"]);

export function linkCodeSenderKey(orgId: string, lineUserId: string): string {
  const secret = process.env.VOTER_BINDING_SECRET?.trim() || "";
  if (secret.length < 32) throw new Error("link_code_guard_key_missing");
  return createHmac("sha256", secret).update(`link_code_sender:${orgId}:${lineUserId}`, "utf8").digest("hex");
}

const refuse = (reason: string) => ({ ok: false as const, replyJa: LINK_CODE_FAILURE_REPLY_JA, reason });

export async function withLinkCodeGuard<T>(
  backend: LinkCodeGuardBackend,
  input: { orgId: string; accountKey: string; lineUserId: string },
  attempt: () => Promise<LinkCodeAttempt<T>>
): Promise<GuardedResult<T>> {
  let r: LinkCodeReservation;
  try {
    const senderKey = linkCodeSenderKey(input.orgId, input.lineUserId);
    r = await backend.reserve(input.orgId, input.accountKey, senderKey);
  } catch {
    return refuse("guard_unavailable");
  }
  if (r.notify) {
    const base = { orgId: input.orgId, accountKey: input.accountKey };
    await backend.alertOps({ ...base, reason: "link_code_account_locked" }).catch(() => undefined);
    if (r.notify === "account_locked_repeat") {
      await backend.alertRepeat({ ...base, reason: "link_code_account_locked_repeat" }).catch(() => undefined);
    }
  }
  if (r.result !== "ok" || !r.attemptId) return refuse(r.result === "ok" ? "guard_unavailable" : r.result);
  const attemptId = r.attemptId;
  const giveBack = () =>
    backend.release(input.orgId, attemptId).catch(() => {
      // the slot stays counted: errs on the strict side, never turns into an accept
      console.error("link_code_release_failed", { orgId: input.orgId, accountKey: input.accountKey });
    });
  const result = await attempt();
  if (result.ok) {
    await giveBack();
    return result;
  }
  if (!WRONG_CODE_REASONS.has(result.reason)) await giveBack();
  return refuse(result.reason);
}

/** Supabase backend: the two SQL functions of migration 20261013200000 + alerts. */
export async function supabaseLinkCodeGuardBackend(): Promise<LinkCodeGuardBackend | null> {
  const { createSupabaseAdminClient } = await import("@/lib/supabase");
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  return {
    async reserve(orgId, accountKey, senderKey) {
      const { data, error } = await admin.rpc("comm_link_code_reserve_attempt", {
        p_org_id: orgId,
        p_account_key: accountKey,
        p_sender_key: senderKey,
      });
      if (error) throw new Error("link_code_reserve_failed");
      const d = (data || {}) as { result?: unknown; attempt_id?: unknown; notify?: unknown };
      if (d.result !== "ok" && d.result !== "sender_locked" && d.result !== "account_locked") throw new Error("link_code_reserve_bad_result");
      const notify = d.notify === "account_locked" || d.notify === "account_locked_repeat" ? d.notify : null;
      return { result: d.result, attemptId: typeof d.attempt_id === "string" ? d.attempt_id : null, notify };
    },
    async release(orgId, attemptId) {
      const { error } = await admin.rpc("comm_link_code_release_attempt", { p_org_id: orgId, p_attempt_id: attemptId });
      if (error) throw new Error("link_code_release_failed");
    },
    alertOps: notifyOpsLinkCodeAccountLocked,
    alertRepeat: notifyLinkCodeAccountLockedRepeat,
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

/**
 * 3 account locks within 24 hours (木村 10/12): ops AND the tenant's approvers, once
 * (the DB returns account_locked_repeat once per 24 hours). IDs only. Never throws.
 */
export async function notifyLinkCodeAccountLockedRepeat(p: { orgId: string; accountKey: string; reason: "link_code_account_locked_repeat" }) {
  const line = `この 24 時間で、同じ窓口の連携コードの受付が 3 回止まりました（間違ったコードが 1 時間に 30 回を超えるたびに 1 時間停止）。`;
  const todo = "対処: 心当たりがなければ総当たりの疑いがあります。運営に連絡するか、Staffpass の設定画面で窓口を無効にしてください。";
  try {
    const { appendAuditEvent } = await import("@/lib/data/audit");
    const meta = { auditClass: "admin", event: "comm.link_code_account_locked_repeat", targetOrgId: p.orgId, accountKey: p.accountKey, reason: p.reason };
    await appendAuditEvent({ orgId: p.orgId, employeeId: null, credentialId: null, action: "comm.link_code_account_locked_repeat", purpose: null, summary: line, metadata: meta }).catch(() => undefined);
    // the tenant's approvers: the org's approval inbox (same path as the emergency-stop notice)
    const { getEnabledNotificationChannels } = await import("@/lib/data/notification-channels");
    const { sendApprovalInboxText } = await import("@/lib/notify/channels");
    const channels = (await getEnabledNotificationChannels(p.orgId)).filter((c) => c.orgId === p.orgId);
    const chosen = channels.find((c) => c.isDefault) ?? channels[0] ?? null;
    if (chosen) await sendApprovalInboxText(chosen, `【Staffpass】LINE 連携コードの受付停止が続いています\n${line}\n${todo}`).catch(() => undefined);
    const to = (process.env.APPROVAL_ALERT_OPS_EMAILS || "").split(",").map((s) => s.trim()).filter((s) => OPS_EMAIL_RE.test(s)).slice(0, 10);
    if (to.length) {
      const { sendTransactionalEmail } = await import("@/lib/resend");
      const opsLine = `${line}（org ${p.orgId} / 窓口 ${p.accountKey}）テナントの承認者にも通知しました。`;
      await sendTransactionalEmail({
        to,
        template: "oauth_security",
        subject: "【運営】LINE: 連携コードの受付停止が 24 時間に 3 回",
        html: `<p>${opsLine}</p>`,
        text: opsLine,
        tags: [{ name: "template", value: "comm_link_code_locked" }],
      }).catch(() => undefined);
    }
  } catch {
    console.warn("comm_link_code_account_locked_repeat", { orgId: p.orgId, accountKey: p.accountKey });
  }
}
