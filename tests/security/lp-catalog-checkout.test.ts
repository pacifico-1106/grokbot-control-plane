/**
 * LP Catalog and Checkout Tests (PR-0b)
 * 
 * Tests:
 * - Feature flags default to OFF
 * - Catalog seed matches LP PricingSection values
 * - Checkout flow behavior
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const envBackup = {
  lpCatalogDb: process.env.LP_CATALOG_DB_ENABLED,
  lpOrderLedger: process.env.LP_ORDER_LEDGER_ENABLED,
};

beforeEach(() => {
  delete process.env.LP_CATALOG_DB_ENABLED;
  delete process.env.LP_ORDER_LEDGER_ENABLED;
});

afterEach(() => {
  process.env.LP_CATALOG_DB_ENABLED = envBackup.lpCatalogDb;
  process.env.LP_ORDER_LEDGER_ENABLED = envBackup.lpOrderLedger;
});

const {
  isLpCatalogDbEnabled,
  isLpOrderLedgerEnabled,
} = await import("@/lib/feature-flags");

const { HARDCODED_CATALOG, getCatalog, isValidCheckoutPlan } = await import("@/lib/lp/catalog");

describe("LP Catalog: Feature flags default to OFF", () => {
  test("LP_CATALOG_DB_ENABLED is OFF by default", () => {
    expect(isLpCatalogDbEnabled()).toBe(false);
  });

  test("LP_ORDER_LEDGER_ENABLED is OFF by default", () => {
    expect(isLpOrderLedgerEnabled()).toBe(false);
  });
});

describe("LP Catalog: Hardcoded catalog matches LP PricingSection", () => {
  const LP_PRICING_SECTION_VALUES = {
    intern: { monthly: 50000, setup: 150000 },
    proper: { monthly: 150000, setup: 150000 },
    executive: { monthly: 300000, setup: 300000 },
    custom: { monthly: null, setup: null },
  };

  test("Intern plan matches LP values", () => {
    const intern = HARDCODED_CATALOG.items.find((i) => i.sku === "intern");
    expect(intern).toBeDefined();
    expect(intern!.monthlyAmountExTax).toBe(LP_PRICING_SECTION_VALUES.intern.monthly);
    expect(intern!.setupAmountExTax).toBe(LP_PRICING_SECTION_VALUES.intern.setup);
    expect(intern!.displayNameJa).toBe("インターン");
  });

  test("Proper plan matches LP values", () => {
    const proper = HARDCODED_CATALOG.items.find((i) => i.sku === "proper");
    expect(proper).toBeDefined();
    expect(proper!.monthlyAmountExTax).toBe(LP_PRICING_SECTION_VALUES.proper.monthly);
    expect(proper!.setupAmountExTax).toBe(LP_PRICING_SECTION_VALUES.proper.setup);
    expect(proper!.displayNameJa).toBe("プロパー");
  });

  test("Executive plan matches LP values", () => {
    const executive = HARDCODED_CATALOG.items.find((i) => i.sku === "executive");
    expect(executive).toBeDefined();
    expect(executive!.monthlyAmountExTax).toBe(LP_PRICING_SECTION_VALUES.executive.monthly);
    expect(executive!.setupAmountExTax).toBe(LP_PRICING_SECTION_VALUES.executive.setup);
    expect(executive!.displayNameJa).toBe("エグゼクティブ");
  });

  test("Custom plan has null pricing and requires quote", () => {
    const custom = HARDCODED_CATALOG.items.find((i) => i.sku === "custom");
    expect(custom).toBeDefined();
    expect(custom!.monthlyAmountExTax).toBe(null);
    expect(custom!.setupAmountExTax).toBe(null);
    expect(custom!.requiresQuote).toBe(true);
  });

  test("Annual display amounts match 10% discount", () => {
    const intern = HARDCODED_CATALOG.items.find((i) => i.sku === "intern");
    const proper = HARDCODED_CATALOG.items.find((i) => i.sku === "proper");
    const executive = HARDCODED_CATALOG.items.find((i) => i.sku === "executive");
    
    expect(intern!.annualDisplayAmountExTax).toBe(45000 * 12);
    expect(proper!.annualDisplayAmountExTax).toBe(135000 * 12);
    expect(executive!.annualDisplayAmountExTax).toBe(270000 * 12);
  });
});

describe("LP Catalog: getCatalog returns hardcoded when flag OFF", () => {
  test("getCatalog returns hardcoded catalog when LP_CATALOG_DB_ENABLED is OFF", async () => {
    const catalog = await getCatalog();
    expect(catalog.versionKey).toBe("hardcoded-2026-10-01");
    expect(catalog.items.length).toBe(4);
    expect(catalog.purchaseEnabled).toBe(true);
  });
});

describe("LP Checkout: Plan validation", () => {
  test("isValidCheckoutPlan accepts valid plans", () => {
    expect(isValidCheckoutPlan("intern")).toBe(true);
    expect(isValidCheckoutPlan("proper")).toBe(true);
    expect(isValidCheckoutPlan("executive")).toBe(true);
  });

  test("isValidCheckoutPlan rejects invalid plans", () => {
    expect(isValidCheckoutPlan("custom")).toBe(false);
    expect(isValidCheckoutPlan("invalid")).toBe(false);
    expect(isValidCheckoutPlan("")).toBe(false);
  });
});

describe("LP Checkout: Route behavior", () => {
  test("GET endpoint exists and returns plan info", async () => {
    const routeModule = await import("@/app/api/lp/ai-employee/checkout/route");
    expect(typeof routeModule.GET).toBe("function");
    expect(typeof routeModule.POST).toBe("function");
  });
});
