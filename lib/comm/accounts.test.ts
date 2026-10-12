import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCommAccount,
  disableCommAccount,
  getActiveCommAccountByWebhookRef,
  listCommAccounts,
  readCommAccountSecretsForServer,
  recordInboundEvent,
  resetDemoCommAccounts,
  setCommAccountSecrets,
} from "@/lib/comm/accounts";

const ENV = ["COMM_ACCOUNTS_ENABLED", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; // demo store
  resetDemoCommAccounts();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ORG = "ec000000-0000-4000-8000-000000000001";
const ORG2 = "ec000000-0000-4000-8000-000000000002";
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = "U" + "1".repeat(32);
const SECRETS = { channelAccessToken: "A".repeat(120), channelSecret: "0123456789abcdef0123456789abcdef" };

async function make(orgId = ORG, employeeId = EMP, externalAccountId = BOT) {
  const r = await createCommAccount({ orgId, employeeId, surface: "line", externalAccountId, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  return r.account;
}

describe("employee comm accounts (C5)", () => {
  test("flag OFF: every call refuses / finds nothing", async () => {
    const a = await make();
    process.env.COMM_ACCOUNTS_ENABLED = "";
    expect(await createCommAccount({ orgId: ORG, employeeId: "e2", surface: "line", externalAccountId: "U" + "2".repeat(32), createdByMemberId: "m" })).toEqual({ ok: false, reason: "disabled" });
    expect(await getActiveCommAccountByWebhookRef(a.webhookRef)).toBeNull();
    expect(await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" })).toEqual({ ok: false, reason: "disabled" });
    expect(await readCommAccountSecretsForServer(ORG, a.id)).toEqual({ ok: false, reason: "disabled" });
  });

  test("webhook ref is unguessable (32 random bytes) and not derived from the bot id", async () => {
    const a = await make();
    expect(a.webhookRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.webhookRef).not.toContain(BOT.slice(1, 8));
  });

  test("one account per employee; an external account id once across orgs", async () => {
    await make();
    expect(await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: "U" + "2".repeat(32), createdByMemberId: "m" })).toEqual({ ok: false, reason: "employee_has_account" });
    expect(await createCommAccount({ orgId: ORG2, employeeId: "ec100000-0000-4000-8000-000000000009", surface: "line", externalAccountId: BOT, createdByMemberId: "m" })).toEqual({ ok: false, reason: "external_account_taken" });
  });

  test("bad values refused", async () => {
    expect((await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: "Uabc", createdByMemberId: "m" })).ok).toBe(false);
    expect((await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line_works" as never, externalAccountId: BOT, createdByMemberId: "m" })).ok).toBe(false);
  });

  test("a new account is pending, so ingress ignores it until secrets are set", async () => {
    const a = await make();
    expect(a.status).toBe("pending");
    expect(await getActiveCommAccountByWebhookRef(a.webhookRef)).toBeNull();
    expect((await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" })).ok).toBe(true);
    const active = await getActiveCommAccountByWebhookRef(a.webhookRef);
    expect(active?.id).toBe(a.id);
    expect(active?.status).toBe("active");
  });

  test("secrets: never in the list view; only names are shown; server read decrypts", async () => {
    const a = await make();
    const set = await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" });
    expect(set).toEqual({ ok: true, secretNames: ["channelAccessToken", "channelSecret"] });
    const list = await listCommAccounts(ORG);
    const text = JSON.stringify(list);
    expect(text).not.toContain(SECRETS.channelSecret);
    expect(text).not.toContain(SECRETS.channelAccessToken);
    expect(text).not.toContain("v2.");
    expect(list[0].secretNames).toEqual(["channelAccessToken", "channelSecret"]);
    expect(await readCommAccountSecretsForServer(ORG, a.id)).toEqual({ ok: true, secrets: SECRETS });
  });

  test("secrets: another org cannot set or read", async () => {
    const a = await make();
    await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" });
    expect(await setCommAccountSecrets({ orgId: ORG2, accountId: a.id, secrets: SECRETS, memberId: "m" })).toEqual({ ok: false, reason: "not_found" });
    expect(await readCommAccountSecretsForServer(ORG2, a.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await listCommAccounts(ORG2)).toEqual([]);
  });

  test("secrets: unknown names, missing names, bad shapes refused (nothing stored)", async () => {
    const a = await make();
    for (const bad of [
      { channelAccessToken: SECRETS.channelAccessToken },
      { ...SECRETS, extra: "x" },
      { ...SECRETS, channelSecret: "not-hex" },
      { ...SECRETS, channelAccessToken: "short" },
      { ...SECRETS, channelAccessToken: "A".repeat(100) + "\n" },
    ]) {
      expect((await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: bad as never, memberId: "m" })).ok).toBe(false);
    }
    expect(await readCommAccountSecretsForServer(ORG, a.id)).toEqual({ ok: false, reason: "no_secrets" });
  });

  test("no encryption key: setting secrets fails closed", async () => {
    const a = await make();
    delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    expect(await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" })).toEqual({ ok: false, reason: "encryption_unavailable" });
  });

  test("disable: ingress no longer finds it; own org only", async () => {
    const a = await make();
    await setCommAccountSecrets({ orgId: ORG, accountId: a.id, secrets: SECRETS, memberId: "m" });
    expect((await disableCommAccount(ORG2, a.id)).ok).toBe(false);
    expect((await disableCommAccount(ORG, a.id)).ok).toBe(true);
    expect(await getActiveCommAccountByWebhookRef(a.webhookRef)).toBeNull();
  });

  test("inbound events: first new, then duplicate; per account", async () => {
    const a = await make();
    const b = await make(ORG, "ec100000-0000-4000-8000-000000000002", "U" + "2".repeat(32));
    expect(await recordInboundEvent(a, "01HXEVENTKEY0001")).toBe("new");
    expect(await recordInboundEvent(a, "01HXEVENTKEY0001")).toBe("duplicate");
    expect(await recordInboundEvent(b, "01HXEVENTKEY0001")).toBe("new");
    expect(await recordInboundEvent(a, "x")).toBe("invalid");
  });
});
