/**
 * PR3 dry-run (木村 2026-10-12, design §3 / §5): a paid LP setup-fee Checkout
 * Session is recorded and 安藤 / operators are notified. No tenant is created.
 * Pure parts: flag, metadata re-validation (markers, never raw), email
 * fingerprint (never raw), amount formatting, notice content, paid decision.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lpAutoProvisionMode } from "@/lib/feature-flags";
import {
  INVALID_MARKER,
  decideLpSetupFeeSession,
  emailFingerprint,
  formatLpAmount,
  lpSetupFeeNoticeText,
  sanitizeLpSetupFeeMetadata,
} from "@/lib/lp/setup-fee-payment";

const EMAIL = "Taro.Yamada+lp@Example.co.jp";

afterEach(() => {
  delete process.env.LP_AUTO_PROVISION_MODE;
});

describe("LP_AUTO_PROVISION_MODE", () => {
  test("default off; only the exact value dry_run turns this PR on; confirm / auto / garbage stay off (not implemented yet)", () => {
    expect(lpAutoProvisionMode()).toBe("off");
    for (const v of ["", "0", "1", "true", "on", "DRY_RUN", " dry_run", "confirm", "auto", "off"]) {
      process.env.LP_AUTO_PROVISION_MODE = v;
      expect(lpAutoProvisionMode()).toBe("off");
    }
    process.env.LP_AUTO_PROVISION_MODE = "dry_run";
    expect(lpAutoProvisionMode()).toBe("dry_run");
  });
});

describe("metadata re-validation", () => {
  test("valid values pass through", () => {
    expect(sanitizeLpSetupFeeMetadata({ plan: "proper", lpPage: "ai-employee-corp", lpRef: "partner_01", referralCode: "aic-abcd1234", orderId: "3f2b8c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e" })).toEqual({
      plan: "proper", lpPage: "ai-employee-corp", lpRef: "partner_01", referralCode: "AIC-ABCD1234", lpOrderId: "3f2b8c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e",
    });
  });
  test("absent optional values → null; absent lpPage → marker (the checkout always sets it)", () => {
    expect(sanitizeLpSetupFeeMetadata({ plan: "intern" })).toEqual({ plan: "intern", lpPage: INVALID_MARKER, lpRef: null, referralCode: null, lpOrderId: null });
  });
  test("tampered values become the marker, never raw", () => {
    const r = sanitizeLpSetupFeeMetadata({
      plan: "enterprise<script>", lpPage: "ai-employee/../admin", lpRef: "<img src=x onerror=1>", referralCode: "AIC-<b>", orderId: "1; drop table",
    });
    expect(r).toEqual({ plan: INVALID_MARKER, lpPage: INVALID_MARKER, lpRef: INVALID_MARKER, referralCode: INVALID_MARKER, lpOrderId: INVALID_MARKER });
    expect(INVALID_MARKER).toBe("(invalid)");
  });
  test("case / whitespace variants of lpPage are not accepted (exact allowlist)", () => {
    expect(sanitizeLpSetupFeeMetadata({ plan: "proper", lpPage: "AI-EMPLOYEE" }).lpPage).toBe(INVALID_MARKER);
    expect(sanitizeLpSetupFeeMetadata({ plan: "proper", lpPage: " ai-employee" }).lpPage).toBe(INVALID_MARKER);
    expect(sanitizeLpSetupFeeMetadata({ plan: "proper", lpRef: "x".repeat(33), lpPage: "ai-employee" }).lpRef).toBe(INVALID_MARKER);
  });
});

describe("customer email: never raw", () => {
  test("sha256 of the trimmed lower-cased address + domain only", () => {
    const f = emailFingerprint(EMAIL);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.sha256).toBe(emailFingerprint("  taro.yamada+lp@example.co.jp ").sha256);
    expect(f.domain).toBe("example.co.jp");
    expect(JSON.stringify(f)).not.toContain("taro");
  });
  test("missing / malformed address → nulls / marker", () => {
    expect(emailFingerprint(null)).toEqual({ sha256: null, domain: null });
    expect(emailFingerprint("no-at-sign")).toEqual({ sha256: null, domain: null });
    expect(emailFingerprint("a@exa mple<.com").domain).toBe(INVALID_MARKER);
  });
});

describe("amount", () => {
  test("zero-decimal JPY and two-decimal USD, with the currency code", () => {
    expect(formatLpAmount(165000, "jpy")).toBe("¥165,000 (JPY)");
    expect(formatLpAmount(12345, "usd")).toBe("123.45 USD");
  });
});

describe("notice text", () => {
  const rec = {
    stripeCheckoutSessionId: "cs_live_a1B2c3",
    amountTotal: 165000,
    currency: "jpy",
    plan: "proper",
    lpPage: "ai-employee-corp",
    lpRef: "partner_01",
    referralCode: "AIC-ABCD1234",
    lpOrderId: null,
    customerEmailDomain: "example.co.jp",
    livemode: true,
  };
  test("amount + currency, lpPage, lpRef, AIC- code, Session ID, dry-run statement; domain only", () => {
    const t = lpSetupFeeNoticeText(rec);
    for (const s of ["¥165,000 (JPY)", "/lp/ai-employee-corp", "partner_01", "AIC-ABCD1234", "cs_live_a1B2c3", "example.co.jp", "テナントは作成していません"]) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain("@");
  });
  test("missing optional values read なし; markers are shown as 不正な値", () => {
    const t = lpSetupFeeNoticeText({ ...rec, lpRef: null, referralCode: INVALID_MARKER, lpPage: INVALID_MARKER, customerEmailDomain: null });
    expect(t).toContain("紹介元(ref): なし");
    expect(t).toContain("紹介コード: 不正な値（破棄）");
    expect(t).toContain("流入ページ: 不正な値（破棄）");
  });
});

describe("paid decision uses the re-fetched Session only", () => {
  const event = { id: "evt_1", type: "checkout.session.completed", livemode: false } as const;
  const session = (over: Record<string, unknown> = {}) => ({
    id: "cs_test_abc123", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", livemode: false,
    amount_total: 165000, currency: "jpy", client_reference_id: null,
    metadata: { source: "lp-ai-employee", plan: "proper", lpPage: "ai-employee" },
    customer_details: { email: EMAIL }, ...over,
  });
  test("paid + complete + lp source → paid record", () => {
    const d = decideLpSetupFeeSession(event, "cs_test_abc123", session() as never);
    expect(d.outcome).toBe("paid");
  });
  for (const [name, over, reason] of [
    ["unpaid", { payment_status: "unpaid" }, "session_unpaid"],
    ["no_payment_required", { payment_status: "no_payment_required" }, "session_unpaid"],
    ["open", { status: "open" }, "session_not_complete"],
    ["other source", { metadata: { source: "billing" } }, "not_lp_session"],
    ["org claim", { client_reference_id: "11111111-1111-4111-8111-111111111111" }, "has_org_claim"],
    ["subscription mode", { mode: "subscription" }, "unsupported_mode"],
    ["livemode mismatch", { livemode: true }, "livemode_mismatch"],
    ["other id", { id: "cs_test_other" }, "session_id_mismatch"],
    ["bad amount", { amount_total: null }, "invalid_amount"],
    ["bad currency", { currency: "JP Y" }, "invalid_currency"],
  ] as const) {
    test(`${name} → ignored (${reason})`, () => {
      const d = decideLpSetupFeeSession(event, "cs_test_abc123", session(over as Record<string, unknown>) as never);
      expect(d).toEqual({ outcome: "ignored", reason });
    });
  }
  test("async_payment_failed → ignored even if the Session says paid", () => {
    expect(decideLpSetupFeeSession({ ...event, type: "checkout.session.async_payment_failed" }, "cs_test_abc123", session() as never)).toEqual({ outcome: "ignored", reason: "async_payment_failed" });
  });
  test("the record carries the sanitized metadata and the email fingerprint, never the address", () => {
    const d = decideLpSetupFeeSession(event, "cs_test_abc123", session({ metadata: { source: "lp-ai-employee", plan: "proper", lpPage: "evil", lpRef: "ok_ref", referralCode: "AIC-ZZZZ9999" } }) as never);
    if (d.outcome !== "paid") throw new Error("expected paid");
    expect(d.record).toMatchObject({ lpPage: INVALID_MARKER, lpRef: "ok_ref", referralCode: "AIC-ZZZZ9999", customerEmailDomain: "example.co.jp", amountTotal: 165000, currency: "jpy" });
    expect(JSON.stringify(d.record)).not.toMatch(/taro/i);
  });
});
