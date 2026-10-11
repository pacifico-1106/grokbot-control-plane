import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/** The 相談 form records which LP the lead came from: inquiry record, outbox payload and email. */
const inquiries: Array<Record<string, unknown>> = [];
const outbox: Array<Record<string, unknown>> = [];
const mails: Array<{ subject: string; html: string }> = [];
let dbOn = false;

mock.module("@/lib/lp/inquiry-data", () => ({
  createInquiry: async (input: Record<string, unknown>) => {
    inquiries.push(input);
    return dbOn ? { id: "inq_1" } : null;
  },
}));
mock.module("@/lib/lp/notification-outbox", () => ({
  enqueueNotification: async (p: Record<string, unknown>) => {
    outbox.push(p);
    return { id: "ob_1" };
  },
  processOutboxEntry: async () => true,
}));
mock.module("@/lib/resend", () => ({
  renderStubHtml: (_t: string, body: string) => body,
  sendTransactionalEmail: async (m: { subject: string; html: string }) => {
    mails.push(m);
    return { ok: true, stub: true };
  },
}));

const ENV = ["AI_EMP_INQUIRY_NOTIFY_EMAIL", "LP_INQUIRY_DB_ENABLED", "LP_INQUIRY_BOT_PROTECTION_ENABLED"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL = "sales@fixture.invalid";
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  inquiries.length = 0;
  outbox.length = 0;
  mails.length = 0;
  dbOn = false;
  delete process.env.LP_INQUIRY_DB_ENABLED;
  delete process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED;
});

const route = await import("./route");
const base = { plan: "intern", company: "株式会社テスト", name: "山田", email: "taro@example.jp", useCase: "日報の下書きを任せたい" };
const post = (extra: Record<string, unknown>) =>
  route.POST(new Request("https://staffpass.example/api/lp/ai-employee/inquiry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, ...extra }) }));

describe("POST /api/lp/ai-employee/inquiry — lead page", () => {
  test("B: email shows 流入ページ /lp/ai-employee-corp (direct send path)", async () => {
    const res = await post({ lpPage: "ai-employee-corp" });
    expect(res.status).toBe(200);
    expect(mails.length).toBe(1);
    expect(mails[0].html).toContain("流入ページ");
    expect(mails[0].html).toContain("/lp/ai-employee-corp");
  });

  test("original (no lpPage): email says /lp/ai-employee", async () => {
    await post({});
    expect(mails[0].html).toContain("流入ページ");
    expect(mails[0].html).toContain("/lp/ai-employee（");
    expect(mails[0].html).not.toContain("ai-employee-corp");
  });

  test("DB ON: inquiry record + outbox payload carry lpPage", async () => {
    process.env.LP_INQUIRY_DB_ENABLED = "true";
    dbOn = true;
    await post({ lpPage: "ai-employee-corp" });
    expect(inquiries[0].lpPage).toBe("ai-employee-corp");
    expect((outbox[0].payload as Record<string, unknown>).lpPage).toBe("ai-employee-corp");
  });

  for (const lpPage of ["AI-EMPLOYEE-CORP", "<img src=x onerror=alert(1)>", "https://evil.example", "ai-employee-corp\u0000", ["ai-employee-corp"], { x: 1 }, 1]) {
    test(`tampered ${JSON.stringify(lpPage).slice(0, 40)} → ai-employee; raw value stored nowhere`, async () => {
      process.env.LP_INQUIRY_DB_ENABLED = "true";
      dbOn = true;
      await post({ lpPage });
      expect(inquiries[0].lpPage).toBe("ai-employee");
      expect((outbox[0].payload as Record<string, unknown>).lpPage).toBe("ai-employee");
      const dump = JSON.stringify([inquiries, outbox, mails]);
      if (typeof lpPage === "string") expect(dump).not.toContain(lpPage.replace("\u0000", ""));
    });
  }
});
