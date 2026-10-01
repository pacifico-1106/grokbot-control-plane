/**
 * LP Catalog data layer.
 * Feature flag LP_CATALOG_DB_ENABLED must be ON to read from DB.
 * When OFF, returns hardcoded constants matching current LP.
 */

import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpCatalogDbEnabled } from "@/lib/feature-flags";

export interface CatalogItem {
  sku: string;
  displayName: string;
  displayNameJa: string;
  monthlyAmountExTax: number | null;
  setupAmountExTax: number | null;
  annualDisplayAmountExTax: number | null;
  stripePriceEnvKey: string | null;
  requiresQuote: boolean;
  catalogVersionKey: string;
}

export interface Catalog {
  items: CatalogItem[];
  versionKey: string;
  purchaseEnabled: boolean;
}

const HARDCODED_CATALOG: Catalog = {
  versionKey: "hardcoded-2026-10-01",
  purchaseEnabled: true,
  items: [
    {
      sku: "intern",
      displayName: "Intern",
      displayNameJa: "インターン",
      monthlyAmountExTax: 50000,
      setupAmountExTax: 150000,
      annualDisplayAmountExTax: 540000,
      stripePriceEnvKey: "STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN",
      requiresQuote: false,
      catalogVersionKey: "hardcoded-2026-10-01",
    },
    {
      sku: "proper",
      displayName: "Proper",
      displayNameJa: "プロパー",
      monthlyAmountExTax: 150000,
      setupAmountExTax: 150000,
      annualDisplayAmountExTax: 1620000,
      stripePriceEnvKey: "STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER",
      requiresQuote: false,
      catalogVersionKey: "hardcoded-2026-10-01",
    },
    {
      sku: "executive",
      displayName: "Executive",
      displayNameJa: "エグゼクティブ",
      monthlyAmountExTax: 300000,
      setupAmountExTax: 300000,
      annualDisplayAmountExTax: 3240000,
      stripePriceEnvKey: "STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE",
      requiresQuote: false,
      catalogVersionKey: "hardcoded-2026-10-01",
    },
    {
      sku: "custom",
      displayName: "Custom",
      displayNameJa: "カスタマイズ",
      monthlyAmountExTax: null,
      setupAmountExTax: null,
      annualDisplayAmountExTax: null,
      stripePriceEnvKey: null,
      requiresQuote: true,
      catalogVersionKey: "hardcoded-2026-10-01",
    },
  ],
};

export async function getCatalog(): Promise<Catalog> {
  if (!isLpCatalogDbEnabled()) {
    return HARDCODED_CATALOG;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.warn("[catalog] DB not configured, using hardcoded catalog");
    return HARDCODED_CATALOG;
  }

  try {
    const { data, error } = await admin.rpc("get_published_lp_catalog");

    if (error || !data || !Array.isArray(data) || data.length === 0) {
      console.warn("[catalog] No published catalog found, using hardcoded");
      return HARDCODED_CATALOG;
    }

    const items: CatalogItem[] = data.map((row: Record<string, unknown>) => ({
      sku: String(row.sku),
      displayName: String(row.display_name),
      displayNameJa: String(row.display_name_ja),
      monthlyAmountExTax: row.monthly_amount_ex_tax ? Number(row.monthly_amount_ex_tax) : null,
      setupAmountExTax: row.setup_amount_ex_tax ? Number(row.setup_amount_ex_tax) : null,
      annualDisplayAmountExTax: row.annual_display_amount_ex_tax ? Number(row.annual_display_amount_ex_tax) : null,
      stripePriceEnvKey: row.stripe_price_env_key ? String(row.stripe_price_env_key) : null,
      requiresQuote: Boolean(row.requires_quote),
      catalogVersionKey: String(row.catalog_version_key),
    }));

    const versionKey = items[0]?.catalogVersionKey || "unknown";

    return {
      items,
      versionKey,
      purchaseEnabled: true,
    };
  } catch (error) {
    console.error("[catalog] Failed to load catalog from DB:", error);
    return HARDCODED_CATALOG;
  }
}

export async function getCatalogItem(sku: string): Promise<CatalogItem | null> {
  const catalog = await getCatalog();
  return catalog.items.find((item) => item.sku === sku) || null;
}

export function getSetupPriceId(item: CatalogItem): string | null {
  if (!item.stripePriceEnvKey) return null;
  const envValue = process.env[item.stripePriceEnvKey];
  if (!envValue || envValue.startsWith("replace_me")) return null;
  return envValue;
}

export function getPlanLabel(sku: string): string {
  switch (sku) {
    case "intern":
      return "インターン";
    case "proper":
      return "プロパー";
    case "executive":
      return "エグゼクティブ";
    case "custom":
      return "カスタマイズ";
    default:
      return sku;
  }
}

export const VALID_CHECKOUT_PLANS = ["intern", "proper", "executive"] as const;
export type CheckoutPlan = (typeof VALID_CHECKOUT_PLANS)[number];

export function isValidCheckoutPlan(plan: string): plan is CheckoutPlan {
  return VALID_CHECKOUT_PLANS.includes(plan as CheckoutPlan);
}

export { HARDCODED_CATALOG };
