/**
 * Flag ON: enqueueNotification subject is the fixed prefix + receipt id.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

const outbox: Array<Record<string, unknown>> = [];

mock.module("@/lib/lp/inquiry-data", () => ({
  createInquiry: async () => ({ id: "inq_1" }),
}));
mock.module("@/lib/lp/notification-outbox", () => ({
  enqueueNotification: async (p: Record<string, unknown>) => {
    outbox.push(p);
    return { id: "ob_1" };
  },
  processOutboxEntry: async () => true,
  renderNotificationHtml: () => "",
}));
mock.module("@/lib/resend", () => ({
  renderStubHtml: (_t: string, body: string) => body,
  sendTransactionalEmail: async () => ({ ok: true, stub: true }),
}));

const FLAG = "LP_INQUIRY_FIXED_SUBJECT_ENABLED";
const DB = "LP_INQUIRY_DB_ENABLED";
const ENV = ["AI_EMP_INQUIRY_NOTIFY_EMAIL", FLAG, DB];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = "sales@fixture.invalid";
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  outbox.length = 0;
  delete process.env[FLAG];
  delete process.env[DB];
});

const route = await import("@/app/api/lp/ai-employee/inquiry/route");

describe("flag ON: enqueueNotification subject is fixed", () => {
  test("enqueueNotification subject is prefix + receipt id only", async () => {
    process.env[FLAG] = "true";
    process.env[DB] = "true";
    const res = await route.POST(
      new Request("https://staffpass.example/api/lp/ai-employee/inquiry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: "intern",
          company: "株式会社テスト",
          name: "山田",
          email: "taro@example.jp",
          useCase: "日報の下書きを任せたい",
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(outbox.length).toBe(1);
    expect(String(outbox[0].subject)).toBe("【AI社員パック問い合わせ】inq_1");
    expect(String(outbox[0].subject)).not.toContain("株式会社テスト");
    expect(String(outbox[0].subject)).not.toContain("山田");
  });
});
