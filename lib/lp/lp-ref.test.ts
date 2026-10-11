import { describe, expect, test } from "bun:test";
import { LP_REF_COOKIE, LP_REF_MAX_LENGTH, parseLpRef, readLpRefCookie, resolveLpRef } from "@/lib/lp/lp-page";
import { parseReferralCode } from "@/lib/auth/signup-guard";

/** ?ref= on pattern B: strict charset + length; invalid values are dropped, never stored raw. */
describe("parseLpRef", () => {
  test("valid", () => {
    for (const v of ["partner_01", "tando", "A", "a-b_c-9", "x".repeat(32), "AIC-AB12"]) expect(parseLpRef(v)).toBe(v);
    expect(LP_REF_MAX_LENGTH).toBe(32);
  });
  const BAD: unknown[] = [
    "", " ", "x".repeat(33), "a b", " partner", "partner ", "a.b", "a/b", "a\\b", "a?b", "a#b", "a=b", "a&b", "a%20b", "a+b", "a@b",
    "<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>", "javascript:alert(1)", "%3Cscript%3E", "紹介者", "ｐａｒｔｎｅｒ", "a\nb", "a\u0000", "a\u200bb",
    null, undefined, 12, ["partner"], { ref: "partner" },
  ];
  for (const v of BAD) {
    test(`dropped: ${JSON.stringify(v)?.slice(0, 40) ?? String(v)}`, () => expect(parseLpRef(v)).toBeNull());
  }
});

describe("ref vs AIC- partner code (separate fields, both validated on their own)", () => {
  test("an AIC- code is a valid ref string but stays a ref; the AIC- parser ignores refs", () => {
    expect(parseLpRef("AIC-AB12")).toBe("AIC-AB12");
    expect(parseReferralCode("AIC-AB12")).toBe("AIC-AB12");
    expect(parseReferralCode("partner_01")).toBe("invalid");
    expect(parseReferralCode("aic-ab12")).toBe("AIC-AB12"); // AIC parser upper-cases; ref never does
    expect(parseLpRef("aic-ab12")).toBe("aic-ab12");
  });
});

describe("cookie carriage", () => {
  test("readLpRefCookie re-validates the HttpOnly cookie value", () => {
    expect(LP_REF_COOKIE).toBe("lp_ref");
    expect(readLpRefCookie("a=1; lp_ref=partner_01; b=2")).toBe("partner_01");
    expect(readLpRefCookie("lp_ref=%3Cscript%3E")).toBeNull();
    expect(readLpRefCookie(`lp_ref=${"x".repeat(33)}`)).toBeNull();
    expect(readLpRefCookie("lp_ref=")).toBeNull();
    expect(readLpRefCookie(null)).toBeNull();
    expect(readLpRefCookie("xlp_ref=partner")).toBeNull();
  });
  test("resolveLpRef: only pattern B records a ref", () => {
    expect(resolveLpRef("ai-employee-corp", "lp_ref=partner_01")).toBe("partner_01");
    expect(resolveLpRef("ai-employee", "lp_ref=partner_01")).toBeNull();
    expect(resolveLpRef("ai-employee-corp", "lp_ref=bad value")).toBeNull();
  });
});
