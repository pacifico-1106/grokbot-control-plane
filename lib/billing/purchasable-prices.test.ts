/**
 * Retired plans (STRIPE_PRICE_ID_BUSINESS / _MANAGED, 八坂さん 10/4: consolidate
 * on the AI社員パック) must not be purchasable. The check is an ALLOWLIST of
 * purchasable Price IDs: anything not on it (retired or unknown) is refused.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  PURCHASABLE_PRICE_ENV_KEYS,
  RETIRED_PRICE_ENV_KEYS,
  checkPurchasablePrice,
  purchasablePriceIds,
} from "./purchasable-prices";

const KEYS = [
  "STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER",
  "STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE",
  "STRIPE_PRICE_ID_BUSINESS",
  "STRIPE_PRICE_ID_MANAGED",
  "STRIPE_PRICE_ID_STARTER",
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN = "price_intern";
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER = "price_proper";
  process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE = "price_exec";
  process.env.STRIPE_PRICE_ID_BUSINESS = "price_business";
  process.env.STRIPE_PRICE_ID_MANAGED = "price_managed";
  process.env.STRIPE_PRICE_ID_STARTER = "price_starter";
});

describe("purchasable price allowlist", () => {
  test("allowlist is exactly the three AI社員パック setup prices", () => {
    expect([...PURCHASABLE_PRICE_ENV_KEYS]).toEqual([
      "STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN",
      "STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER",
      "STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE",
    ]);
    expect([...RETIRED_PRICE_ENV_KEYS]).toEqual([
      "STRIPE_PRICE_ID_BUSINESS",
      "STRIPE_PRICE_ID_MANAGED",
      "STRIPE_PRICE_ID_STARTER",
    ]);
    expect([...purchasablePriceIds()].sort()).toEqual(["price_exec", "price_intern", "price_proper"]);
  });

  for (const id of ["price_intern", "price_proper", "price_exec"]) {
    test(`AI社員パック ${id} → ok`, () => {
      expect(checkPurchasablePrice(id)).toEqual({ ok: true, priceId: id });
    });
  }

  for (const id of ["price_business", "price_managed", "price_starter"]) {
    test(`retired ${id} → 410 plan_retired with a Japanese message`, () => {
      const r = checkPurchasablePrice(id);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(410);
      expect(r.error).toBe("plan_retired");
      expect(r.message).toContain("新規のお申し込みは終了");
      expect(r.message).toContain("AI社員パック");
      expect(r.message).not.toContain(id);
    });
  }

  for (const id of ["price_unknown", "", "replace_me", null, undefined]) {
    test(`unknown / not allowlisted ${JSON.stringify(id)} → 404 price_not_purchasable`, () => {
      const r = checkPurchasablePrice(id as string | null | undefined);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(404);
      expect(r.error).toBe("price_not_purchasable");
      expect(r.message).toMatch(/[ぁ-んァ-ン]/);
    });
  }

  test("misconfiguration: an AI社員パック env set to the retired STARTER price is refused (410)", () => {
    process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER = "price_starter";
    const r = checkPurchasablePrice("price_starter");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(410);
    expect(purchasablePriceIds().has("price_starter")).toBe(false);
  });

  test("misconfiguration: an AI社員パック env set to a retired price is still refused (410)", () => {
    process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN = "price_business";
    const r = checkPurchasablePrice("price_business");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(410);
    expect(purchasablePriceIds().has("price_business")).toBe(false);
  });

  test("unset / replace_me allowlist entries are never purchasable", () => {
    process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER = "replace_me_later";
    delete process.env.STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE;
    expect([...purchasablePriceIds()]).toEqual(["price_intern"]);
    expect(checkPurchasablePrice("replace_me_later").ok).toBe(false);
  });
});
