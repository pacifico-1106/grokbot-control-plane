/**
 * Standalone result page renderer (API routes that answer HTML without React).
 * Same look as the app: theme tokens + shared rules copied from app/globals.css
 * (this test fails when the copy drifts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as page from "@/lib/ui/standalone-result-page";

function ruleMap(css: string): Map<string, string> {
  const out = new Map<string, string>();
  // Top-level rules only (skip @media / @theme / @keyframes blocks).
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === ";" && depth === 0) {
      start = i + 1; // top-level statement such as @import
    } else if (c === "{") {
      if (depth === 0) {
        selector = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
        start = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        if (!selector.startsWith("@")) {
          const body = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").split(";").map((d) => d.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ");
          for (const sel of selector.split(",").map((s) => s.trim())) out.set(sel, body);
        }
        start = i + 1;
      }
    }
  }
  return out;
}

const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

describe("standalone result page", () => {
  test("theme: every shared rule and :root token is identical to app/globals.css", () => {
    const fromApp = ruleMap(globals);
    const fromPage = ruleMap(page.STANDALONE_RESULT_PAGE_SHARED_CSS);
    expect(fromPage.size).toBeGreaterThan(8);
    for (const [selector, body] of fromPage) {
      if (selector === ":root") continue;
      expect({ selector, body }).toEqual({ selector, body: fromApp.get(selector)! });
    }
    const appRoot = fromApp.get(":root")!.split("; ");
    for (const decl of fromPage.get(":root")!.split("; ")) expect(appRoot).toContain(decl);
    for (const cls of [".surface", ".muted", ".faint", ".btn", ".btn-primary", ".btn-ghost", ".chip", ".chip-ok", ".chip-danger", ".eyebrow"]) {
      expect(fromPage.has(cls)).toBe(true);
    }
  });

  test("support code only on failure; malformed support code → unknown", () => {
    const ok = page.renderStandaloneResultPage({ ok: true, title: "t", lead: "l", nextSteps: ["n"], supportCode: "installed" });
    expect(ok).not.toContain("問い合わせコード");
    expect(ok).not.toContain("installed");
    const ng = page.renderStandaloneResultPage({ ok: false, title: "t", lead: "l", nextSteps: ["n"], supportCode: "save_failed" });
    expect(ng).toContain("問い合わせコード");
    expect(ng).toContain("<code>save_failed</code>");
    const odd = page.renderStandaloneResultPage({ ok: false, title: "t", lead: "l", nextSteps: ["n"], supportCode: "<b>Bad Code</b>" });
    expect(odd).toContain("<code>unknown</code>");
    expect(odd).not.toContain("Bad Code");
  });

  test("every value is escaped; non-http(s) / non-path links are dropped", () => {
    const html = page.renderStandaloneResultPage({
      ok: false,
      title: `<t>"'&`,
      lead: "<lead>",
      details: [{ label: "<l>", value: "<v>" }],
      nextSteps: ["<step>"],
      actions: [
        { href: "/app/settings?a=1&b=<2>", label: "<a1>", primary: true },
        { href: "javascript:alert(1)", label: "x" },
        { href: "//evil.example/x", label: "y" },
      ],
    });
    for (const raw of ["<t>", "<lead>", "<l>", "<v>", "<step>", "<a1>", "<2>"]) expect(html).not.toContain(raw);
    expect(html).toContain("&lt;t&gt;&quot;&#39;&amp;");
    expect(html).toContain('href="/app/settings?a=1&amp;b=&lt;2&gt;"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
  });

  test("next steps section is always present and marked for tests / assistive tech", () => {
    const html = page.renderStandaloneResultPage({ ok: true, title: "t", lead: "l", nextSteps: ["a", "b"] });
    expect(html).toMatch(/<section[^>]*data-next[^>]*aria-labelledby="next-h"/);
    expect(html).toContain("次にやること");
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<li>b</li>");
  });
});
