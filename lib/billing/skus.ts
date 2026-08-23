/**
 * Additional Ando / Kimura SKUs beyond recurring plans (P0.5+).
 * Client-safe — display + catalog constants only.
 *
 * displayYen values are 税別・仮決め／事業確定前.
 * Stripe Dashboard Prices (env) remain Checkout source of truth.
 * Do NOT invent fake price_… ids. Meter stays gated_confirm_action
 * (see lib/billing/meter.ts) — separate from these packs.
 */

import { formatYenJa, PRICING_PROVISIONAL_NOTE_JA } from "./plans";

export { formatYenJa, PRICING_PROVISIONAL_NOTE_JA };

/** One-time optional kickoff pack (税別・仮決め), yen. */
export const KICKOFF_PACK_YEN = 398_000;

/**
 * Transparent packaging lines for kickoff_pack (sales / invoice honesty).
 * Total = KICKOFF_PACK_YEN. Line yen are provisional packaging splits —
 * a single Stripe Price may still back Checkout until line Prices exist.
 *
 * Grok seat = Pro+/Teams band pass-through — NOT Premium ($120) band.
 *
 * CRITICAL: does NOT include Business (or any) subscription first month.
 * Recurring plan fee is always a separate subscription line to avoid
 * double-billing kickoff vs monthly.
 */
export const KICKOFF_PACK_LINES = [
  {
    key: "staffpass_kickoff_setup",
    labelJa: "Staffpass キックオフ設定・就業規則テンプレ適用",
    yen: 198_000,
  },
  {
    key: "grok_seat_passthrough",
    labelJa:
      "Grok Bot 席代パススルー（Pro+/Teams 帯。Premium $120 帯ではない）",
    yen: 60_000,
  },
  {
    key: "kickoff_companion",
    labelJa: "キックオフ伴走（連携チェック・テスト承認・日報導線）",
    yen: 140_000,
  },
] as const;

export const KICKOFF_PACK_NOTE_JA =
  "任意・一式（税別・仮決め）。月額プランとは別請求。Business 初月をキックオフに含めない（二重請求回避）。";

export const KICKOFF_GROK_BAND_JA =
  "Grok 席代は Pro+/Teams 帯のパススルー。Premium（$120）帯は使わない。";

/** Managed core monthly (same as PLAN_DISPLAY_YEN.managed). */
export const MANAGED_CORE_YEN = 128_000;

/**
 * Optional sales packaging presentation for Managed — not a separate billed
 * SKU unless later decided. Core Checkout remains ¥128,000 / month.
 */
export const MANAGED_BUNDLE_PACKAGING_YEN = 168_000;

export const MANAGED_BUNDLE_NOTE_JA =
  `Managed コアは ${formatYenJa(MANAGED_CORE_YEN)} / 月。営業パッケージ提示として任意バンドル ${formatYenJa(MANAGED_BUNDLE_PACKAGING_YEN)}（仮決め・包装メモ）。Checkout の正はコア月額。`;

/**
 * Subsidy-related catalog keys — placeholders only.
 * NO guarantee language about 補助金採択・交付・満額.
 */
export type SubsidySkuKey =
  | "subsidy_2y_business"
  | "subsidy_2y_managed"
  | "year3_extension";

export const SUBSIDY_SKU_KEYS: readonly SubsidySkuKey[] = [
  "subsidy_2y_business",
  "subsidy_2y_managed",
  "year3_extension",
] as const;

export const SUBSIDY_SKU_LABELS_JA: Record<SubsidySkuKey, string> = {
  subsidy_2y_business: "補助金パッケージ（Business・2年想定）",
  subsidy_2y_managed: "補助金パッケージ（Managed・2年想定）",
  year3_extension: "3年目延長オプション",
};

/** Compliance copy — never claim approval / payout guarantee. */
export const SUBSIDY_COMPLIANCE_NOTE_JA =
  "補助金関連パッケージはカタログ準備中です。採択・交付・金額を保証するものではありません。制度要件・申請は顧客（または認定支援機関等）の責任です。詳細はお問い合わせください。";

export const SUBSIDY_COMING_SOON_JA =
  "補助金パック（2年 Business / 2年 Managed / 3年目延長）は準備中です。ご関心はお問い合わせください。";
