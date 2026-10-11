import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LP_PAGE,
  LP_PAGES,
  lpPageHomePath,
  normalizeLpPage,
  parseLpPage,
  withLpPageParam,
} from "@/lib/lp/lp-page";

/** Which LP a lead came from: fixed server-side allowlist, never the raw input. */
describe("LP page allowlist", () => {
  test("exactly two pages, original first (= safe default)", () => {
    expect([...LP_PAGES]).toEqual(["ai-employee", "ai-employee-corp"]);
    expect(DEFAULT_LP_PAGE).toBe("ai-employee");
  });

  test("known values are accepted as-is", () => {
    expect(parseLpPage("ai-employee")).toBe("ai-employee");
    expect(parseLpPage("ai-employee-corp")).toBe("ai-employee-corp");
    expect(normalizeLpPage("ai-employee-corp")).toBe("ai-employee-corp");
  });

  const TAMPERED: unknown[] = [
    undefined,
    null,
    "",
    " ",
    "AI-EMPLOYEE-CORP",
    "Ai-Employee-Corp",
    " ai-employee-corp",
    "ai-employee-corp ",
    "ai-employee-corp\n",
    "ai-employee-corp\u0000",
    "ａｉ-employee-corp", // full-width homoglyph
    "ai‐employee‐corp", // U+2010 hyphen
    "/lp/ai-employee-corp",
    "ai-employee-corp?x=1",
    "ai-employee-corp#x",
    "ai-employee-corp/../admin",
    "https://evil.example/lp/ai-employee-corp",
    "//evil.example",
    "javascript:alert(1)",
    "<script>alert(1)</script>",
    "ai-employee-corp".repeat(100),
    "lp-ai-employee",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    ["ai-employee-corp"],
    { toString: () => "ai-employee-corp" },
    { value: "ai-employee-corp" },
    123,
    true,
    Symbol("ai-employee-corp"),
  ];

  for (const raw of TAMPERED) {
    const label = typeof raw === "symbol" ? "Symbol" : JSON.stringify(raw)?.slice(0, 60) ?? String(raw);
    test(`rejected: ${label}`, () => {
      expect(parseLpPage(raw)).toBeNull();
      expect(normalizeLpPage(raw)).toBe("ai-employee");
    });
  }

  test("home paths are fixed constants", () => {
    expect(lpPageHomePath("ai-employee")).toBe("/lp/ai-employee");
    expect(lpPageHomePath("ai-employee-corp")).toBe("/lp/ai-employee-corp");
  });

  test("withLpPageParam: original stays byte-identical, B adds from=ai-employee-corp", () => {
    expect(withLpPageParam("/lp/ai-employee/consult", "ai-employee")).toBe("/lp/ai-employee/consult");
    expect(withLpPageParam("/lp/ai-employee/checkout?plan=intern", "ai-employee")).toBe("/lp/ai-employee/checkout?plan=intern");
    expect(withLpPageParam("/lp/ai-employee/consult", "ai-employee-corp")).toBe("/lp/ai-employee/consult?from=ai-employee-corp");
    expect(withLpPageParam("/lp/ai-employee/checkout?plan=intern", "ai-employee-corp")).toBe(
      "/lp/ai-employee/checkout?plan=intern&from=ai-employee-corp"
    );
  });
});
