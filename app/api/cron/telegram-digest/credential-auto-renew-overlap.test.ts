/**
 * telegram-digest runs the 24h overlap old-revoke loop only when
 * CREDENTIAL_AUTO_RENEW_ENABLED is ON. A failure never fails the digest.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let digestCalls = 0;
let overlapCalls = 0;
let overlapThrows = false;
mock.module("@/lib/notify/channels", () => ({
  sendTenantDigests: async () => {
    digestCalls += 1;
    return [{ ok: true, provider: "slack" }];
  },
}));
mock.module("@/lib/employees/credential-expiry-notice", () => ({
  runCredentialExpiryNotices: async () => ({
    orgs: 0,
    notified: 0,
    sent: 0,
    failed: 0,
    deferred: 0,
    cappedOrgs: 0,
    noInbox: 0,
    skippedMismatch: 0,
  }),
}));
mock.module("@/lib/employees/credential-auto-renew-overlap", () => ({
  expireOverlappedOldCredentials: async () => {
    overlapCalls += 1;
    if (overlapThrows) throw new Error("boom");
    return { orgs: 1, revoked: 2, failed: 0 };
  },
}));
mock.module("@/lib/security/cron-secret", () => ({ rejectUnauthorizedCron: () => null }));
const { GET } = await import("./route");

afterEach(() => {
  delete process.env.CREDENTIAL_AUTO_RENEW_ENABLED;
  delete process.env.CREDENTIAL_EXPIRY_NOTICE_ENABLED;
  digestCalls = 0;
  overlapCalls = 0;
  overlapThrows = false;
});

describe("telegram-digest cron × credential auto-renew overlap", () => {
  test("flag OFF (default): digest only, no overlap loop, response unchanged", async () => {
    const body = await (await GET(new Request("https://x/api/cron/telegram-digest"))).json();
    expect(digestCalls).toBe(1);
    expect(overlapCalls).toBe(0);
    expect(body).toEqual({ ok: true, deliveries: 1, failed: 0 });
  });

  test("flag ON: overlap loop runs after the digest; counts only", async () => {
    process.env.CREDENTIAL_AUTO_RENEW_ENABLED = "1";
    const body = await (await GET(new Request("https://x/api/cron/telegram-digest"))).json();
    expect(overlapCalls).toBe(1);
    expect(body.credentialAutoRenewOverlap).toMatchObject({ revoked: 2, failed: 0 });
  });

  test("flag ON + overlap throws: digest still ok, error code only, no secret", async () => {
    process.env.CREDENTIAL_AUTO_RENEW_ENABLED = "1";
    overlapThrows = true;
    const res = await GET(new Request("https://x/api/cron/telegram-digest"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.credentialAutoRenewOverlap).toEqual({ error: "credential_auto_renew_overlap_failed" });
    expect(JSON.stringify(body)).not.toMatch(/gb_emp_|claim_token/);
  });
});
