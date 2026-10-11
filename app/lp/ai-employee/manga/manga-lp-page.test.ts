import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";
import * as Index from "@/app/lp/ai-employee/manga/page";
import * as Intern from "@/app/lp/ai-employee/manga/intern/page";
import * as Proper from "@/app/lp/ai-employee/manga/proper/page";
import * as Executive from "@/app/lp/ai-employee/manga/executive/page";

/**
 * Manga pages reached from LP pattern B carry from=ai-employee-corp so the 相談 form
 * records B. `from` is exact-match allowlisted; anything else renders A byte-identically
 * (golden HTML captured from the pages before this change). Links are picked from fixed
 * paths only; `from` never becomes a URL, and the pages never redirect.
 */
type SP = Record<string, string | string[] | undefined>;
type PageModule = {
  default: (props: { searchParams: Promise<SP> }) => Promise<ReactElement> | ReactElement;
  generateMetadata: (props: { searchParams: Promise<SP> }) => Promise<Metadata>;
};
const PAGES: Array<[string, PageModule, string]> = [
  ["index", Index as unknown as PageModule, "app/lp/ai-employee/manga/page.tsx"],
  ["intern", Intern as unknown as PageModule, "app/lp/ai-employee/manga/intern/page.tsx"],
  ["proper", Proper as unknown as PageModule, "app/lp/ai-employee/manga/proper/page.tsx"],
  ["executive", Executive as unknown as PageModule, "app/lp/ai-employee/manga/executive/page.tsx"],
];
const FIX = "app/lp/__fixtures__/manga";
const render = async (m: PageModule, sp: SP) => renderToStaticMarkup(await m.default({ searchParams: Promise.resolve(sp) }));
const hrefs = (h: string) => [...h.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, "&"));
const TAMPERED: unknown[] = ["AI-EMPLOYEE-CORP", "ai-employee-corp ", " ai-employee-corp", "https://evil.example", "//evil.example", "/lp/ai-employee-corp", "javascript:alert(1)", "ai-employee-corp%00", ["ai-employee-corp", "x"], "", "ai-employee"];

for (const [name, mod, file] of PAGES) {
  describe(`manga ${name}`, () => {
    const golden = readFileSync(`${FIX}/${name}.html`, "utf8");
    const goldenMeta = JSON.parse(readFileSync(`${FIX}/${name}.metadata.json`, "utf8"));

    test("A (missing from): HTML and metadata identical to before", async () => {
      expect(await render(mod, {})).toBe(golden);
      expect(JSON.parse(JSON.stringify(await mod.generateMetadata({ searchParams: Promise.resolve({}) })))).toEqual(goldenMeta);
    });

    for (const from of TAMPERED) {
      test(`tampered from=${JSON.stringify(from)} → A, value never echoed`, async () => {
        const h = await render(mod, { from: from as string });
        expect(h).toBe(golden);
        expect(JSON.parse(JSON.stringify(await mod.generateMetadata({ searchParams: Promise.resolve({ from: from as string }) })))).toEqual(goldenMeta);
      });
    }

    test("B: every 相談 / manga link carries from=ai-employee-corp; LP links go back to B", async () => {
      const h = await render(mod, { from: "ai-employee-corp" });
      const links = hrefs(h).filter((x) => x.startsWith("/lp/"));
      expect(links.length).toBeGreaterThan(0);
      for (const x of links) {
        if (x.startsWith("/lp/ai-employee/consult") || x.startsWith("/lp/ai-employee/manga")) expect(x).toContain("from=ai-employee-corp");
        else expect(x.startsWith("/lp/ai-employee-corp")).toBe(true);
      }
      expect(links.some((x) => x.startsWith("/lp/ai-employee/consult"))).toBe(true);
      expect(links.some((x) => x.startsWith("/lp/ai-employee-corp"))).toBe(true);
      expect(links).not.toContain("/lp/ai-employee");
      expect(links.some((x) => x.startsWith("/lp/ai-employee#"))).toBe(false);
    });

    test("B: robots noindex/noai (B context stays out of search); A metadata untouched", async () => {
      const meta = await mod.generateMetadata({ searchParams: Promise.resolve({ from: "ai-employee-corp" }) });
      expect(meta.robots).toBe("noindex, follow, noai, noimageai");
      expect(meta.title).toBe(goldenMeta.title);
    });

    test("ref on the URL is ignored and never rendered (cookie flow is middleware-only)", async () => {
      const h = await render(mod, { from: "ai-employee-corp", ref: "partner_01" });
      expect(h).not.toContain("partner_01");
      expect(h).not.toMatch(/[?&;]ref=/);
      expect(h).toBe(await render(mod, { from: "ai-employee-corp" }));
    });

    test("no redirect is ever built from `from`", () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/\bredirect\(|permanentRedirect|NextResponse\.redirect|location\.(assign|replace|href)/);
    });
  });
}
