import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { lpCorpRefResponse } from "@/lib/lp/lp-ref-middleware";
import { config, middleware } from "@/middleware";

/**
 * /lp/ai-employee-corp?ref=… : a valid ref goes into an HttpOnly cookie and the URL is
 * cleaned (ref never stays in the address bar / Referer / screenshots); an invalid ref is dropped.
 */
const BASE = "https://staffpass.example";
const run = (path: string) => lpCorpRefResponse(new NextRequest(`${BASE}${path}`));

describe("lpCorpRefResponse", () => {
  test("valid ref → 307 to the same page without ref, HttpOnly SameSite=Lax cookie", () => {
    const res = run("/lp/ai-employee-corp?ref=partner_01&utm_source=x")!;
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/lp/ai-employee-corp?utm_source=x`);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain("lp_ref=partner_01");
    expect(sc.toLowerCase()).toContain("httponly");
    expect(sc.toLowerCase()).toContain("samesite=lax");
    expect(sc.toLowerCase()).toContain("path=/");
    expect(sc.toLowerCase()).toContain("max-age=");
  });
  for (const bad of ["%3Cscript%3Ealert(1)%3C%2Fscript%3E", "x".repeat(33), "a%20b", "a.b", "%E7%B4%B9%E4%BB%8B"]) {
    test(`invalid ref ${bad.slice(0, 20)} → URL cleaned, no cookie, value not echoed`, () => {
      const res = run(`/lp/ai-employee-corp?ref=${bad}`)!;
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${BASE}/lp/ai-employee-corp`);
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  }
  test("no ref → nothing to do; other paths untouched", () => {
    expect(run("/lp/ai-employee-corp")).toBeNull();
    expect(run("/lp/ai-employee?ref=partner_01")).toBeNull();
    expect(run("/lp/ai-employee-corp/x?ref=partner_01")).toBeNull();
    expect(run("/lp/ai-employee/manga?from=ai-employee-corp&ref=partner_01")).toBeNull();
  });
  test("middleware wires it in before auth (works in demo mode too)", async () => {
    const res = await middleware(new NextRequest(`${BASE}/lp/ai-employee-corp?ref=partner_01`));
    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toContain("lp_ref=partner_01");
    expect(config.matcher).toContain("/lp/ai-employee-corp");
  });
});
