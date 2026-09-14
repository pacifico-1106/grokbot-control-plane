/**
 * Customer-facing pack definitions (Yasaka two-layer pricing).
 * 
 * Customer sees: AI社員 Lite / Standard / Kickoff / Care
 * Back-end SKUs: starter / business / managed (Stripe/cost — NOT shown to customers)
 * 
 * Tax-exclusive list prices (税抜).
 * Stripe Dashboard Prices remain the source of truth for Checkout charges.
 * 
 * @see docs/pricing-model.md
 * @see lib/billing/plans.ts (back-end SKU constants)
 */

import { formatYenJa } from "./plans";

export type PackId = "lite" | "standard";
export type AddonId = "kickoff" | "care";

/**
 * Customer-facing pack definitions.
 * Maps to back-end SKUs for Stripe but names are NOT shown to customers.
 */
export interface CustomerPack {
  id: PackId;
  /** Back-end SKU for Stripe Price mapping. DO NOT display to customers. */
  backendSku: "starter" | "business" | "managed";
  /** Customer-facing display name (Japanese). */
  displayName: string;
  /** Monthly price (tax-exclusive, 税抜). */
  monthlyYen: number;
  /** Pack highlights for customer UI. */
  points: string[];
  /** Seat scale guidance. */
  scaleNote: string;
  /** Whether this is the featured/recommended option. */
  featured?: boolean;
}

export interface CustomerAddon {
  id: AddonId;
  displayName: string;
  /** Yen amount (tax-exclusive). */
  yen: number;
  /** one-time or monthly. */
  billing: "one_time" | "monthly";
  /** Optional tag. */
  optional: boolean;
  description: string;
}

/**
 * Customer-facing packs (tax-exclusive / 税抜).
 * Lite vs Standard = scale/accompaniment (1 vs ~3 seats, monthly review).
 * Control plane core is the same.
 */
export const CUSTOMER_PACKS: CustomerPack[] = [
  {
    id: "lite",
    backendSku: "business",
    displayName: "AI社員 Lite",
    monthlyYen: 98_000,
    points: [
      "AI社員1名〜の小規模運用",
      "承認・監査・日報",
      "セルフオンボーディング",
    ],
    scaleNote: "1名〜",
    featured: false,
  },
  {
    id: "standard",
    backendSku: "managed",
    displayName: "AI社員 Standard",
    monthlyYen: 198_000,
    points: [
      "AI社員3名程度までの運用",
      "Liteの全機能",
      "月次レビュー・伴走サポート",
    ],
    scaleNote: "〜3名",
    featured: true,
  },
];

/**
 * Customer-facing add-ons (tax-exclusive / 税抜).
 */
export const CUSTOMER_ADDONS: CustomerAddon[] = [
  {
    id: "kickoff",
    displayName: "導入（キックオフ）",
    yen: 300_000,
    billing: "one_time",
    optional: true,
    description:
      "初期設定代行・就業規則テンプレ適用・連携チェック・テスト承認の伴走を一式で。",
  },
  {
    id: "care",
    displayName: "Care",
    yen: 80_000,
    billing: "monthly",
    optional: true,
    description:
      "継続的な運用サポート。要再連携の一次対応・週次ヘルスチェック。",
  },
];

/** Format yen for customer display (Japanese). */
export { formatYenJa };

/** Get the customer pack by ID. */
export function getPackById(id: PackId): CustomerPack | undefined {
  return CUSTOMER_PACKS.find((p) => p.id === id);
}

/** Get the customer addon by ID. */
export function getAddonById(id: AddonId): CustomerAddon | undefined {
  return CUSTOMER_ADDONS.find((a) => a.id === id);
}

/**
 * Map a back-end plan key to customer pack display name.
 * Used for displaying current subscription in pack terms.
 */
export function packDisplayNameFromBackendSku(
  sku: "starter" | "business" | "managed" | string | null | undefined
): string {
  switch (sku) {
    case "starter":
    case "business":
      return "AI社員 Lite";
    case "managed":
      return "AI社員 Standard";
    default:
      return "AI社員 Lite";
  }
}

/**
 * Note for customer UI about hands (Grok Bot) being bundled.
 * Stripe Price separation kept for pack vs hands passthrough.
 */
export const HANDS_BUNDLED_NOTE_JA =
  "手足（Grok Bot）の席代はパックに含まれます。Stripe 請求では管理上分離されますが、顧客への追加課金はありません。";

/**
 * Tax-exclusive note for customer UI.
 */
export const TAX_EXCLUSIVE_NOTE_JA = "表示価格は税抜です";
