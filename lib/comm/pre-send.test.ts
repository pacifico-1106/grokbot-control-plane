/**
 * 木村 10/12 (item 4): right before a LINE send on an employee's own account, the
 * server re-checks — fresh, every send, even with an unexpired conversation token —
 *   (1) the account is still active (and still this org's, this employee's),
 *   (2) the counterparty's link is not removed (when the conversation relied on it),
 *   (3) the employee is not on emergency stop or leave (nor the org).
 * Any read failure refuses (fail closed). Nothing here is decided by AI arguments.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __setHoldReaderForTests, type HoldReader } from "@/lib/safety/hold";
import { checkLineSendAllowed, type PreSendDeps } from "@/lib/comm/pre-send";

const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const ACCT = "ec200000-0000-4000-8000-000000000001";
const USER = "U" + "a".repeat(32);
const target = { orgId: ORG, employeeId: EMP, accountId: ACCT, counterpartyId: USER };

const account = (over: Record<string, unknown> = {}) => ({
  id: ACCT, orgId: ORG, employeeId: EMP, surface: "line" as const, externalAccountId: "U" + "f".repeat(32),
  webhookRef: "R".repeat(43), status: "active" as const, displayName: null, ...over,
});
function deps(over: Partial<PreSendDeps> = {}): PreSendDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getAccount: async (o, id) => { calls.push(`account:${o}:${id}`); return account(); },
    getLink: async (o, acct, user) => { calls.push(`link:${o}:${acct}:${user}`); return { status: "active" }; },
    ...over,
  };
}
const reader = (emp: string | null, org: string | null = null, broken = false): HoldReader => ({
  employee: async () => (broken ? { state: "error", detail: "x" } : { state: "found", orgId: ORG, holdState: emp, holdId: emp ? "h1" : null }),
  org: async () => ({ state: "found", orgId: ORG, holdState: org, holdId: org ? "h2" : null }),
});
afterEach(() => __setHoldReaderForTests(null));

describe("checkLineSendAllowed", () => {
  test("active account, link present, no hold → allowed; every check ran", async () => {
    __setHoldReaderForTests(reader(null));
    const d = deps();
    expect(await checkLineSendAllowed({ ...target, requiresLink: true }, d)).toEqual({ ok: true });
    expect(d.calls).toEqual([`account:${ORG}:${ACCT}`, `link:${ORG}:comm_account:${ACCT}:${USER}`]);
  });

  test("account disabled / pending → refused", async () => {
    __setHoldReaderForTests(reader(null));
    for (const status of ["disabled", "pending"]) {
      expect(await checkLineSendAllowed(target, deps({ getAccount: async () => account({ status }) as never })))
        .toEqual({ ok: false, reason: "comm_account_inactive" });
    }
  });

  test("account gone, or now another employee's / another org's → refused", async () => {
    __setHoldReaderForTests(reader(null));
    expect(await checkLineSendAllowed(target, deps({ getAccount: async () => null }))).toEqual({ ok: false, reason: "comm_account_inactive" });
    for (const over of [{ employeeId: "ec100000-0000-4000-8000-000000000009" }, { orgId: "ec000000-0000-4000-8000-000000000009" }]) {
      expect(await checkLineSendAllowed(target, deps({ getAccount: async () => account(over) as never })))
        .toEqual({ ok: false, reason: "comm_account_mismatch" });
    }
  });

  test("account read fails → refused (fail closed)", async () => {
    __setHoldReaderForTests(reader(null));
    expect(await checkLineSendAllowed(target, deps({ getAccount: async () => { throw new Error("db"); } })))
      .toEqual({ ok: false, reason: "comm_account_unavailable" });
  });

  test("link removed / revoked / expired → refused when the conversation relied on it; read failure → refused", async () => {
    __setHoldReaderForTests(reader(null));
    for (const link of [null, { status: "revoked" }, { status: "expired" }, { status: "pending" }]) {
      expect(await checkLineSendAllowed({ ...target, requiresLink: true }, deps({ getLink: async () => link })))
        .toEqual({ ok: false, reason: "counterparty_link_removed" });
    }
    expect(await checkLineSendAllowed({ ...target, requiresLink: true }, deps({ getLink: async () => { throw new Error("db"); } })))
      .toEqual({ ok: false, reason: "counterparty_link_unavailable" });
  });

  test("an external counterparty (no link needed): the link is not read", async () => {
    __setHoldReaderForTests(reader(null));
    const d = deps({ getLink: async () => { throw new Error("must not be read"); } });
    expect(await checkLineSendAllowed({ ...target, requiresLink: false }, d)).toEqual({ ok: true });
  });

  test("employee on emergency stop, on leave or quarantined → refused; org stop → refused; hold unreadable → refused", async () => {
    for (const kind of ["stopped", "leave", "quarantined"]) {
      __setHoldReaderForTests(reader(kind));
      expect(await checkLineSendAllowed(target, deps())).toEqual({ ok: false, reason: "employee_on_hold" });
    }
    __setHoldReaderForTests(reader(null, "stopped"));
    expect(await checkLineSendAllowed(target, deps())).toEqual({ ok: false, reason: "org_on_hold" });
    __setHoldReaderForTests(reader(null, null, true));
    expect(await checkLineSendAllowed(target, deps())).toEqual({ ok: false, reason: "hold_state_unavailable" });
  });

  test("fresh every send: a stop or a disable between two sends refuses the second", async () => {
    __setHoldReaderForTests(reader(null));
    let status = "active";
    const d = deps({ getAccount: async () => account({ status }) as never });
    expect((await checkLineSendAllowed(target, d)).ok).toBe(true);
    __setHoldReaderForTests(reader("leave"));
    expect(await checkLineSendAllowed(target, d)).toEqual({ ok: false, reason: "employee_on_hold" });
    __setHoldReaderForTests(reader(null));
    status = "disabled";
    expect(await checkLineSendAllowed(target, d)).toEqual({ ok: false, reason: "comm_account_inactive" });
  });

  test("bad ids refused before any read", async () => {
    const d = deps();
    expect(await checkLineSendAllowed({ ...target, counterpartyId: "not-a-line-user" }, d)).toEqual({ ok: false, reason: "invalid_target" });
    expect(await checkLineSendAllowed({ ...target, accountId: "x" }, d)).toEqual({ ok: false, reason: "invalid_target" });
    expect(d.calls).toEqual([]);
  });

  test("default deps: comm accounts OFF → no account → refused (never sends on a switched-off surface)", async () => {
    __setHoldReaderForTests(reader(null));
    const saved = process.env.COMM_ACCOUNTS_ENABLED;
    delete process.env.COMM_ACCOUNTS_ENABLED;
    try {
      expect(await checkLineSendAllowed(target)).toEqual({ ok: false, reason: "comm_account_inactive" });
    } finally {
      if (saved !== undefined) process.env.COMM_ACCOUNTS_ENABLED = saved;
    }
  });
});
