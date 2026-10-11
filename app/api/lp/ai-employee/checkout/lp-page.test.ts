import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Checkout records which LP the lead came from (metadata.lpPage), from a fixed
 * allowlist. success / cancel URLs are built server-side from fixed paths only.
 */
const APP = "https://staffpass.example";
const created: Array<Record<string, unknown>> = [];
mock.module("@/lib/stripe", () => ({
  getAppUrl: () => APP,
  getCheckoutPaymentMethodTypes: () => ["card"],
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          created.push(args);
          return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
        },
      },
    },
  }),
}));

const ENV = ["STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN", "LP_ORDER_LEDGER_ENABLED", "LP_CATALOG_DB_ENABLED"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  created.length = 0;
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN = "price_test_intern";
  delete process.env.LP_ORDER_LEDGER_ENABLED;
  delete process.env.LP_CATALOG_DB_ENABLED;
});

const route = await import("./route");

const post = (body: Record<string, unknown>, cookie?: string) =>
  route.POST(new Request(`${APP}/api/lp/ai-employee/checkout`, { method: "POST", headers: { "content-type": "application/json", origin: APP, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));

const ORIGINAL_SUCCESS = `${APP}/lp/ai-employee/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=intern`;
const ORIGINAL_CANCEL = `${APP}/lp/ai-employee?checkout=canceled`;

describe("POST /api/lp/ai-employee/checkout — lead page", () => {
  test("original (no lpPage): URLs exactly as before, metadata.lpPage = ai-employee, source unchanged", async () => {
    const res = await post({ plan: "intern" });
    expect(res.status).toBe(200);
    const s = created[0];
    expect(s.success_url).toBe(ORIGINAL_SUCCESS);
    expect(s.cancel_url).toBe(ORIGINAL_CANCEL);
    const md = s.metadata as Record<string, string>;
    expect(md.source).toBe("lp-ai-employee");
    expect(md.lpPage).toBe("ai-employee");
    expect((s.payment_intent_data as { metadata: Record<string, string> }).metadata.lpPage).toBe("ai-employee");
  });

  test("pattern B: metadata.lpPage = ai-employee-corp on session + payment intent; cancel returns to B", async () => {
    await post({ plan: "intern", lpPage: "ai-employee-corp" });
    const s = created[0];
    expect((s.metadata as Record<string, string>).lpPage).toBe("ai-employee-corp");
    expect((s.metadata as Record<string, string>).source).toBe("lp-ai-employee");
    expect((s.payment_intent_data as { metadata: Record<string, string> }).metadata.lpPage).toBe("ai-employee-corp");
    expect(s.success_url).toBe(`${APP}/lp/ai-employee/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=intern&from=ai-employee-corp`);
    expect(s.cancel_url).toBe(`${APP}/lp/ai-employee-corp?checkout=canceled`);
  });

  for (const lpPage of ["AI-EMPLOYEE-CORP", "ai-employee-corp ", "https://evil.example", "/lp/ai-employee-corp", "x".repeat(600), ["ai-employee-corp"], { a: 1 }, 7, null, "__proto__"]) {
    test(`tampered lpPage ${JSON.stringify(lpPage).slice(0, 40)} → safe default, never stored raw`, async () => {
      await post({ plan: "intern", lpPage });
      const s = created[0];
      const md = s.metadata as Record<string, string>;
      expect(md.lpPage).toBe("ai-employee");
      expect(s.success_url).toBe(ORIGINAL_SUCCESS);
      expect(s.cancel_url).toBe(ORIGINAL_CANCEL);
      const dump = JSON.stringify(s);
      if (typeof lpPage === "string" && lpPage !== "ai-employee-corp ") expect(dump).not.toContain(lpPage.slice(0, 30));
    });
  }

  test("no open redirect: successUrl / cancelUrl / returnUrl / from in the body are ignored", async () => {
    await post({
      plan: "intern",
      lpPage: "ai-employee-corp",
      successUrl: "https://evil.example/s",
      success_url: "https://evil.example/s",
      cancelUrl: "https://evil.example/c",
      cancel_url: "https://evil.example/c",
      returnUrl: "https://evil.example/r",
      from: "https://evil.example/f",
    });
    const dump = JSON.stringify(created[0]);
    expect(dump).not.toContain("evil.example");
    expect(String(created[0].success_url).startsWith(`${APP}/lp/ai-employee/thank-you?`)).toBe(true);
    expect(String(created[0].cancel_url).startsWith(`${APP}/lp/ai-employee-corp?`)).toBe(true);
  });

  test("B + valid lp_ref cookie → metadata.lpRef (session + payment intent); URLs never carry it", async () => {
    await post({ plan: "intern", lpPage: "ai-employee-corp" }, "lp_ref=partner_01");
    const s = created[0];
    expect((s.metadata as Record<string, string>).lpRef).toBe("partner_01");
    expect((s.payment_intent_data as { metadata: Record<string, string> }).metadata.lpRef).toBe("partner_01");
    expect(String(s.success_url)).not.toContain("partner_01");
    expect(String(s.cancel_url)).not.toContain("partner_01");
  });

  test("ref: A ignores the cookie; invalid cookie dropped; body ref / lpRef never trusted", async () => {
    for (const [body, cookie] of [
      [{ plan: "intern" }, "lp_ref=partner_01"],
      [{ plan: "intern", lpPage: "ai-employee-corp" }, `lp_ref=${"x".repeat(33)}`],
      [{ plan: "intern", lpPage: "ai-employee-corp" }, "lp_ref=%3Cscript%3E"],
      [{ plan: "intern", lpPage: "ai-employee-corp", ref: "partner_01", lpRef: "partner_01" }, undefined],
    ] as const) {
      created.length = 0;
      await post(body as Record<string, unknown>, cookie);
      expect("lpRef" in (created[0].metadata as Record<string, string>)).toBe(false);
      expect(JSON.stringify(created[0])).not.toContain("script");
    }
  });

  test("ref together with an AIC- code: separate fields, AIC code not turned into lpRef", async () => {
    await post({ plan: "intern", lpPage: "ai-employee-corp", referral_code: "AIC-AB12" }, "lp_ref=partner_01");
    const md = created[0].metadata as Record<string, string>;
    expect(md.lpRef).toBe("partner_01");
    expect(JSON.stringify(md)).not.toContain("AIC-AB12");
    created.length = 0;
    await post({ plan: "intern", lpPage: "ai-employee-corp", referral_code: "partner_01" }, "lp_ref=AIC-AB12");
    expect((created[0].metadata as Record<string, string>).lpRef).toBe("AIC-AB12");
  });

  test("GET consultUrl follows the allowlisted from= (B) and ignores tampered values", async () => {
    const get = async (q: string) => (await (await route.GET(new Request(`${APP}/api/lp/ai-employee/checkout?plan=intern${q}`))).json()) as { consultUrl: string };
    expect((await get("")).consultUrl).toBe(`${APP}/lp/ai-employee/consult?plan=intern`);
    expect((await get("&from=ai-employee-corp")).consultUrl).toBe(`${APP}/lp/ai-employee/consult?plan=intern&from=ai-employee-corp`);
    expect((await get("&from=https%3A%2F%2Fevil.example")).consultUrl).toBe(`${APP}/lp/ai-employee/consult?plan=intern`);
    expect((await get("&from=AI-EMPLOYEE-CORP")).consultUrl).toBe(`${APP}/lp/ai-employee/consult?plan=intern`);
  });
});
