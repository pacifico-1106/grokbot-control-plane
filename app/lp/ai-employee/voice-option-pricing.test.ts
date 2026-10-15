import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OriginalPage from "@/app/lp/ai-employee/page";
import CorpPage from "@/app/lp/ai-employee-corp/page";
import { PricingSection, VOICE_OPTION_RATES, VOICE_OPTION_STATUS } from "@/app/lp/ai-employee/PricingSection";

/**
 * Voice phone option on LP A/B: upcoming, usage-based, not a purchasable plan.
 * Do not name underlying vendors on the customer page.
 */
const ENV = ["LP_CHAT_ENABLED", "LP_HANDOFF_ENABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const html = (el: ReactElement) => renderToStaticMarkup(el);

const EXPECTED_RATES = [
  { id: "number", label: "電話番号（050）", amount: 1500, unit: "/月" },
  { id: "inbound", label: "着信", amount: 25, unit: "/分" },
  { id: "outbound-mobile", label: "発信（携帯電話）", amount: 70, unit: "/分" },
  { id: "outbound-landline", label: "発信（固定電話）", amount: 40, unit: "/分" },
] as const;

describe("LP voice option pricing (upcoming, usage-based)", () => {
  test("decided 2026-10-16 rates are the source of truth", () => {
    expect(VOICE_OPTION_STATUS).toBe("提供予定（オプション、従量課金）");
    expect([...VOICE_OPTION_RATES]).toEqual([...EXPECTED_RATES]);
  });

  test("A and B pricing sections show the option, rates, and 税別", () => {
    delete process.env.LP_CHAT_ENABLED;
    delete process.env.LP_HANDOFF_ENABLED;
    const pages = [
      html(OriginalPage() as ReactElement),
      html(CorpPage() as ReactElement),
      html(createElement(PricingSection, { lpPage: "ai-employee" })),
      html(createElement(PricingSection, { lpPage: "ai-employee-corp" })),
    ];
    for (const h of pages) {
      expect(h).toContain('data-testid="lp-voice-option"');
      expect(h).toContain(VOICE_OPTION_STATUS);
      expect(h).toContain("電話応対オプション");
      expect(h).toContain("いくつものやり方があります");
      expect(h).toContain("担当者が出る");
      expect(h).toContain("メールやチャットに回す");
      expect(h).toContain("今お使いの電話サービスを続ける");
      expect(h).toContain("まだ提供していません");
      expect(h).toContain("電話応対オプション（提供予定）はプラン料金とは別に、番号月額と通話分の従量課金です");
      for (const row of EXPECTED_RATES) {
        expect(h).toContain(row.label);
        expect(h).toContain(`¥${row.amount.toLocaleString("ja-JP")}`);
        expect(h).toContain(row.unit);
      }
      expect(h).not.toContain("plan=voice");
      const start = h.indexOf('data-testid="lp-voice-option"');
      expect(start).toBeGreaterThanOrEqual(0);
      const voice = h.slice(start, start + 4000);
      expect(voice).not.toMatch(/Twilio/i);
      expect(voice).not.toMatch(/\bGrok\b/i);
    }
  });

  test("voice consult CTA carries the LP page param on B only", () => {
    const slice = (markup: string) => {
      const start = markup.indexOf('data-testid="lp-voice-option"');
      expect(start).toBeGreaterThanOrEqual(0);
      return markup.slice(start, start + 4000);
    };
    const a = slice(html(createElement(PricingSection, { lpPage: "ai-employee" })));
    const b = slice(html(createElement(PricingSection, { lpPage: "ai-employee-corp" })));
    expect(a).toContain("電話の受け方を相談する");
    expect(a).toContain('href="/lp/ai-employee/consult"');
    expect(a).not.toContain("checkout");
    expect(b).toContain('href="/lp/ai-employee/consult?from=ai-employee-corp"');
    expect(b).not.toContain("checkout");
  });

  test("FAQ presents voice as one of several phone options", () => {
    const src = readFileSync("app/lp/ai-employee/AIEmployeeLanding.tsx", "utf8");
    expect(src).toContain("電話対応もAI社員に任せられる？");
    expect(src).toContain("いくつものやり方があります");
    expect(src).toContain("提供予定・従量課金");
    expect(src).toContain("月1,500円（税別）");
    expect(src).toContain("1分25円");
    expect(src).toContain("1分70円");
    expect(src).toContain("1分40円");
    const faq = src.slice(src.indexOf("電話対応もAI社員に任せられる？"), src.indexOf("初期費用と月額の違いは？"));
    expect(faq).not.toMatch(/Twilio/i);
    expect(faq).not.toMatch(/\bGrok\b/i);
  });
});
