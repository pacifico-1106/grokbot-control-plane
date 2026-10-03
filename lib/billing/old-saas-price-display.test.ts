import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_PACKS } from "./packs";
import { PLAN_DISPLAY_YEN, PLAN_OVERAGE_YEN, PLAN_ONBOARDING_YEN } from "./plans";
import { KICKOFF_PACK_YEN, MANAGED_CORE_YEN } from "./skus";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** 現行の AI社員 導入パック（税別）。LP 料金表と特商法表記の金額。 */
const CURRENT_TIERS = [
  { labelJa: "インターン", monthly: 50000, setup: 150000 },
  { labelJa: "プロパー", monthly: 150000, setup: 150000 },
  { labelJa: "エグゼクティブ", monthly: 300000, setup: 300000 },
];

describe("旧SaaS価格の表示（2026-10-03 洗い出し）", () => {
  test("請求画面は LP/特商法に無い任意オプション（キックオフ・Care）の金額を表示しない", () => {
    const src = read("components/BillingClient.tsx");
    expect(src).not.toContain("CUSTOMER_ADDONS");
    expect(src).not.toContain("KICKOFF_PACK_LINES");
    expect(src).toContain('href="/lp/ai-employee#pricing"');
    expect(src).toContain('href="/legal/commercial-transactions"');
  });

  test("LP の申込み導線の税表記は LP 料金表・特商法表記と同じ「税別」", () => {
    for (const p of [
      "app/lp/ai-employee/checkout/page.tsx",
      "app/lp/ai-employee/thank-you/page.tsx",
      "app/lp/ai-employee/ChatLauncher.tsx",
    ]) {
      expect(read(p)).not.toContain("税抜");
      expect(read(p)).toContain("税別");
    }
  });

  test("LP 料金表・特商法表記・LP カタログ既定値の金額は一致している", () => {
    const pricing = read("app/lp/ai-employee/PricingSection.tsx");
    const tokusho = read("app/legal/commercial-transactions/page.tsx");
    const catalog = read("lib/lp/catalog.ts");
    for (const t of CURRENT_TIERS) {
      expect(catalog).toContain(`displayNameJa: "${t.labelJa}",\n      monthlyAmountExTax: ${t.monthly},\n      setupAmountExTax: ${t.setup},`);
      expect(pricing).toContain(`monthly: ${t.monthly},`);
      expect(pricing).toContain(`setupFee: ${t.setup},`);
      const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
      expect(tokusho).toContain(`${t.labelJa}: 初期費用 ${yen(t.setup)}（税別）／月額 ${yen(t.monthly)}`);
      expect(tokusho).toContain(`年額 ${yen(t.monthly * 0.9 * 12)}`);
    }
  });

  test("課金・Stripe 連携側の定数はこの PR で変更していない（要確認として据え置き）", () => {
    expect(PLAN_DISPLAY_YEN).toEqual({ starter: 12_000, business: 39_800, managed: 128_000 });
    expect(PLAN_OVERAGE_YEN).toEqual({ starter: 80, business: 40, managed: 25 });
    expect(PLAN_ONBOARDING_YEN).toEqual({ business: 150_000 });
    expect(CUSTOMER_PACKS.map((p) => [p.id, p.backendSku, p.monthlyYen])).toEqual([
      ["lite", "business", 98_000],
      ["standard", "managed", 198_000],
    ]);
    expect(KICKOFF_PACK_YEN).toBe(300_000);
    expect(MANAGED_CORE_YEN).toBe(128_000);
  });
});
