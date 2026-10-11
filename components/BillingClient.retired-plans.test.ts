import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /app/billing: the retired plans (AI社員 Lite = BUSINESS, Standard = MANAGED)
 * no longer have a purchase button (八坂さん 10/4). Existing subscribers keep
 * the 契約内容を管理 (Stripe Billing Portal) button.
 */
mock.module("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
const { BillingClient } = await import("./BillingClient");

const render = (props: { hasStripeCustomer?: boolean; stripeConfigured?: boolean }) =>
  renderToStaticMarkup(createElement(BillingClient, props));

describe("BillingClient after the retired-plan stop", () => {
  for (const stripeConfigured of [true, false]) {
    test(`no purchase button for Lite / Standard (stripeConfigured=${stripeConfigured})`, () => {
      const html = render({ stripeConfigured, hasStripeCustomer: true });
      expect(html).not.toContain("お支払いに進む");
      expect(html).not.toContain("オンライン決済 準備中");
      expect(html).not.toContain("パックを選ぶ");
      expect(html).not.toContain("¥98,000");
      expect(html).not.toContain("¥198,000");
    });
  }

  test("shows that new sign-ups ended and links to the AI社員パック", () => {
    const html = render({ stripeConfigured: true, hasStripeCustomer: true });
    expect(html).toContain('data-testid="billing-retired-plans-note"');
    expect(html).toContain("新規のお申し込みは終了");
    expect(html).toContain('href="/lp/ai-employee#pricing"');
  });

  test("existing subscriber keeps the Portal button (契約内容を管理)", () => {
    const html = render({ stripeConfigured: true, hasStripeCustomer: true });
    expect(html).toContain("契約内容を管理");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>契約内容を管理/);
  });

  test("the client no longer calls /api/billing/checkout at all", () => {
    const src = readFileSync(new URL("./BillingClient.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("/api/billing/checkout");
    expect(src).not.toContain("planKey");
  });
});
