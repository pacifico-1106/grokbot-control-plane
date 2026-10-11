/**
 * The daily digest cron runs the 社員証 pre-expiry notice only with
 * CREDENTIAL_EXPIRY_NOTICE_ENABLED ON; a notice failure never fails the digest.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let digestCalls = 0;
let noticeCalls = 0;
let noticeThrows = false;
mock.module("@/lib/notify/channels", () => ({
  sendTenantDigests: async () => {
    digestCalls++;
    return [{ ok: true, provider: "slack" }];
  },
}));
mock.module("@/lib/employees/credential-expiry-notice", () => ({
  runCredentialExpiryNotices: async () => {
    noticeCalls++;
    if (noticeThrows) throw new Error("boom");
    return { orgs: 1, notified: 2, sent: 1, failed: 0, deferred: 0, cappedOrgs: 0, noInbox: 0, skippedMismatch: 0 };
  },
}));
mock.module("@/lib/security/cron-secret", () => ({ rejectUnauthorizedCron: () => null }));
const { GET } = await import("./route");

afterEach(() => {
  delete process.env.CREDENTIAL_EXPIRY_NOTICE_ENABLED;
  digestCalls = 0;
  noticeCalls = 0;
  noticeThrows = false;
});

describe("telegram-digest cron × credential expiry notice", () => {
  test("flag OFF (default): digest only, no notice, response unchanged", async () => {
    const body = await (await GET(new Request("https://x/api/cron/telegram-digest"))).json();
    expect(digestCalls).toBe(1);
    expect(noticeCalls).toBe(0);
    expect(body).toEqual({ ok: true, deliveries: 1, failed: 0 });
  });
  test("flag ON: notice runs after the digest; counts only in the response", async () => {
    process.env.CREDENTIAL_EXPIRY_NOTICE_ENABLED = "1";
    const body = await (await GET(new Request("https://x/api/cron/telegram-digest"))).json();
    expect(noticeCalls).toBe(1);
    expect(body.credentialExpiryNotice).toMatchObject({ notified: 2, sent: 1 });
  });
  test("flag ON + notice throws: digest result still ok, error code only", async () => {
    process.env.CREDENTIAL_EXPIRY_NOTICE_ENABLED = "1";
    noticeThrows = true;
    const res = await GET(new Request("https://x/api/cron/telegram-digest"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.credentialExpiryNotice).toEqual({ error: "credential_expiry_notice_failed" });
  });
});
