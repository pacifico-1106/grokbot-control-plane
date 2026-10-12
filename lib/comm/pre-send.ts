/**
 * Right-before-send re-check for a LINE message on an employee's own account
 * (木村 10/12, item 4; design §5「停止」). Runs fresh on EVERY send, after the
 * conversation token was verified and immediately before the LINE API call:
 *   (1) the account is still active and still this org's and this employee's
 *   (2) the counterparty's link is not removed — when the conversation relied on
 *       it (a linked member counts as internal). The link is the LINE voter
 *       binding on channel key "comm_account:<accountId>".
 *   (3) the employee is not on emergency stop / leave / quarantine, nor the org
 *       (checkOperable phase "pre_send" — always re-read, never cached)
 * An unexpired token does not skip any of these. Every read failure refuses.
 * Reads statuses only; no secret is read here.
 */
import { preSendHoldCode } from "@/lib/safety/hold";

export type PreSendTarget = {
  orgId: string;
  employeeId: string;
  accountId: string;
  counterpartyId: string;
  /** true when the conversation is treated as internal because the counterparty is linked */
  requiresLink?: boolean;
};
export type PreSendResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_target"
        | "comm_account_inactive"
        | "comm_account_mismatch"
        | "comm_account_unavailable"
        | "counterparty_link_removed"
        | "counterparty_link_unavailable"
        | "employee_on_hold"
        | "org_on_hold"
        | "hold_state_unavailable";
    };

type AccountLike = { id: string; orgId: string; employeeId: string; status: string } | null;
type LinkLike = { status: string } | null;
export type PreSendDeps = {
  getAccount(orgId: string, accountId: string): Promise<AccountLike>;
  getLink(orgId: string, channelKey: string, lineUserId: string): Promise<LinkLike>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_USER_RE = /^U[0-9a-f]{32}$/;

export const defaultPreSendDeps: PreSendDeps = {
  async getAccount(orgId, accountId) {
    const { getCommAccountForSend } = await import("@/lib/comm/accounts");
    return getCommAccountForSend(orgId, accountId);
  },
  async getLink(orgId, channelKey, lineUserId) {
    const { getVoterBinding } = await import("@/lib/approval-workflow/voter-binding");
    return getVoterBinding(orgId, "line", channelKey, lineUserId);
  },
};

export async function checkLineSendAllowed(t: PreSendTarget, deps: PreSendDeps = defaultPreSendDeps): Promise<PreSendResult> {
  if (![t.orgId, t.employeeId, t.accountId].every((x) => UUID_RE.test(String(x || ""))) || !LINE_USER_RE.test(String(t.counterpartyId || ""))) {
    return { ok: false, reason: "invalid_target" };
  }
  let account: AccountLike;
  try {
    account = await deps.getAccount(t.orgId, t.accountId);
  } catch {
    return { ok: false, reason: "comm_account_unavailable" };
  }
  if (!account) return { ok: false, reason: "comm_account_inactive" };
  if (account.id !== t.accountId || account.orgId !== t.orgId || account.employeeId !== t.employeeId) {
    return { ok: false, reason: "comm_account_mismatch" };
  }
  if (account.status !== "active") return { ok: false, reason: "comm_account_inactive" };
  if (t.requiresLink) {
    let link: LinkLike;
    try {
      link = await deps.getLink(t.orgId, `comm_account:${t.accountId}`, t.counterpartyId);
    } catch {
      return { ok: false, reason: "counterparty_link_unavailable" };
    }
    if (!link || link.status !== "active") return { ok: false, reason: "counterparty_link_removed" };
  }
  // last, so it is the read closest to the LINE API call
  const hold = await preSendHoldCode(t.orgId, t.employeeId).catch(() => "hold_state_unavailable" as const);
  if (hold) return { ok: false, reason: hold };
  return { ok: true };
}
