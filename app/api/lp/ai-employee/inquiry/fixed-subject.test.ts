/**
 * POST /api/lp/ai-employee/inquiry — LP_INQUIRY_FIXED_SUBJECT_ENABLED.
 * Flag OFF: subject still has 会社 / 名前. Flag ON: fixed subject + receipt id,
 * no mailto, user strings only in the escaped body.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

const mails: Array<{ subject: string; html: string }> = [];

mock.module("@/lib/lp/inquiry-data", () => ({
  createInquiry: async () => null,
}));
mock.module("@/lib/lp/notification-outbox", () => ({
  enqueueNotification: async () => null,
  processOutboxEntry: async () => true,
}));
mock.module("@/lib/resend", () => ({
  renderStubHtml: (_t: string, body: string) => body,
  sendTransactionalEmail: async (m: { subject: string; html: string }) => {
    mails.push(m);
    return { ok: true, stub: true };
  },
}));

const FLAG = "LP_INQUIRY_FIXED_SUBJECT_ENABLED";
const ENV = ["AI_EMP_INQUIRY_NOTIFY_EMAIL", FLAG];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = "sales@fixture.invalid";
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  mails.length = 0;
  delete process.env[FLAG];
});

const route = await import("./route");
const base = {
  plan: "intern",
  company: "株式会社テスト",
  name: "山田",
  email: "taro@example.jp",
  useCase: "日報の下書きを任せたい https://evil.example",
};
const post = (extra: Record<string, unknown> = {}) =>
  route.POST(
    new Request("https://staffpass.example/api/lp/ai-employee/inquiry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, ...extra }),
    })
  );

describe("POST inquiry — LP_INQUIRY_FIXED_SUBJECT_ENABLED", () => {
  test("flag OFF: subject still has company and name (today)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe("【AI社員パック問い合わせ】株式会社テスト - 山田様");
    expect(mails[0].html).toContain("mailto:taro@example.jp");
  });

  test("flag ON: subject is fixed + receipt; no company/name; no links", async () => {
    process.env[FLAG] = "true";
    const res = await post({
      company: "Evil\r\nBcc: x@evil.example",
      name: '<a href="https://phish.example">x</a>',
    });
    expect(res.status).toBe(200);
    expect(mails.length).toBe(1);
    expect(mails[0].subject.startsWith("【AI社員パック問い合わせ】")).toBe(true);
    expect(mails[0].subject).not.toContain("Evil");
    expect(mails[0].subject).not.toContain("山田");
    expect(mails[0].subject).not.toContain("株式会社テスト");
    expect(mails[0].subject).not.toMatch(/[\r\n]/);
    expect(mails[0].html).not.toContain("<a href=");
    expect(mails[0].html).not.toContain("mailto:");
    expect(mails[0].html).toContain("https://evil.example");
  });
});
