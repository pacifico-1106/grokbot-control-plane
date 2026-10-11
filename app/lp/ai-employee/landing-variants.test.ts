import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OriginalPage, { metadata as originalMetadata } from "@/app/lp/ai-employee/page";
import CorpPage, { metadata as corpMetadata } from "@/app/lp/ai-employee-corp/page";
import { AIEmployeeLanding } from "@/app/lp/ai-employee/AIEmployeeLanding";
import { getLpVariant } from "@/app/lp/ai-employee/variants";
import { FloatingYouTubePromo, PromoDesktopPlayer, PromoMobilePlayer } from "@/app/lp/ai-employee/FloatingYouTubePromo";

/**
 * LP pattern B (/lp/ai-employee-corp) shares every component with /lp/ai-employee;
 * only the variant config differs. The original page must render byte-identically
 * to main (fixtures captured from main a2f0b42 before the refactor).
 */
const FIX = "app/lp/__fixtures__";
const ENV = ["LP_CHAT_ENABLED", "LP_HANDOFF_ENABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function chat(on: boolean) {
  if (on) {
    process.env.LP_CHAT_ENABLED = "true";
    process.env.LP_HANDOFF_ENABLED = "true";
  } else {
    delete process.env.LP_CHAT_ENABLED;
    delete process.env.LP_HANDOFF_ENABLED;
  }
}
const html = (el: ReactNode) => renderToStaticMarkup(el as ReactElement);
const visibleText = (h: string) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

/** Elements of `type` in the tree a component returns (one level of components, no rendering). */
function findElements(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => findElements(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    findElements((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

describe("original /lp/ai-employee is unchanged", () => {
  test("chat OFF: HTML identical to main", () => {
    chat(false);
    expect(html(OriginalPage())).toBe(readFileSync(`${FIX}/ai-employee.chat-off.html`, "utf8"));
  });
  test("chat ON: HTML identical to main", () => {
    chat(true);
    expect(html(OriginalPage())).toBe(readFileSync(`${FIX}/ai-employee.chat-on.html`, "utf8"));
  });
  test("metadata identical to main (no robots / canonical added)", () => {
    expect(JSON.parse(JSON.stringify(originalMetadata))).toEqual(JSON.parse(readFileSync(`${FIX}/ai-employee.metadata.json`, "utf8")));
  });
  test("original keeps its video, banner and supervision", () => {
    const v = getLpVariant("ai-employee");
    expect(v.video.id).toBe("l4fVZ1-VRcU");
    expect(v.showCampaignBanner).toBe(true);
    expect(v.showSupervision).toBe(true);
  });
});

describe("pattern B /lp/ai-employee-corp", () => {
  for (const on of [false, true]) {
    test(`no 先行100枠 / 監修 / 八坂 anywhere in the markup (chat ${on ? "ON" : "OFF"})`, () => {
      chat(on);
      const h = html(CorpPage());
      for (const banned of ["先行100枠", "先行", "100枠", "監修", "八坂", "Yasaka", "taiyo-yasaka", "tyasaka", "SUPERVISION", "trust-ribbon", "キャンペーン情報", "枠に達し次第"]) {
        expect(h).not.toContain(banned);
      }
      // supervision gallery / profile assets
      for (const asset of ["ai-business-speaking-session", "generative-ai-app-training", "ai-agent-business-seminar", "ai-advisory-session", "youtube-ai-agents-100cho", "l4fVZ1-VRcU", "miraishachu"]) {
        expect(h).not.toContain(asset);
      }
    });
  }

  test("keeps only the developer / operator info (TOKYO307 intro + logo)", () => {
    chat(false);
    const h = html(CorpPage());
    expect(h).toContain("tokyo307-logo-stacked-reverse.svg");
    expect(h).toContain("開発・運営");
    expect(h).toContain("トーキョーサンマルナナ株式会社");
    expect(h).toContain("0→1開発アトリエ");
  });

  test("service name 「Staffpass（AIエージェントの社員証）」 in title, hero, pillars, philosophy and footer", () => {
    chat(false);
    const h = html(CorpPage());
    const NAME = "Staffpass（AIエージェントの社員証）";
    expect(String(corpMetadata.title)).toContain(NAME);
    expect(String(corpMetadata.description)).toContain(NAME);
    const h1 = h.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? "";
    expect(visibleText(h1)).toContain(NAME);
    expect(visibleText(h1)).not.toContain("AI社員 by Staffpass");
    expect(h.split(NAME).length - 1).toBeGreaterThanOrEqual(5);
    const footer = h.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
    expect(footer).toContain(NAME);
  });

  test("floating promo uses video UFKh_CK9uxw (B only)", () => {
    const corp = getLpVariant("ai-employee-corp");
    expect(corp.video.id).toBe("UFKh_CK9uxw");
    expect(corp.video.storageKey).not.toBe(getLpVariant("ai-employee").video.storageKey);
    const promos = findElements(AIEmployeeLanding({ variant: "ai-employee-corp" }), FloatingYouTubePromo);
    expect(promos.length).toBe(1);
    expect((promos[0].props as { video: { id: string } }).video.id).toBe("UFKh_CK9uxw");
    const desktop = html(createElement(PromoDesktopPlayer, { video: corp.video, onCollapse: () => undefined }));
    expect(desktop).toContain("https://www.youtube-nocookie.com/embed/UFKh_CK9uxw?rel=0");
    expect(desktop).not.toContain("l4fVZ1-VRcU");
    const mobile = html(createElement(PromoMobilePlayer, { video: corp.video, onCollapse: () => undefined }));
    expect(mobile).toContain("https://youtu.be/UFKh_CK9uxw");
    expect(mobile).not.toContain("l4fVZ1-VRcU");
    expect(mobile).not.toContain("youtube-ai-agents-100cho");
    const original = html(createElement(PromoDesktopPlayer, { video: getLpVariant("ai-employee").video, onCollapse: () => undefined }));
    expect(original).toContain("https://www.youtube-nocookie.com/embed/l4fVZ1-VRcU?rel=0");
  });

  test("every 相談 / Checkout link carries from=ai-employee-corp; no link to an unknown page", () => {
    chat(true);
    const h = html(CorpPage());
    const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    const leadLinks = hrefs.filter((x) => /\/lp\/ai-employee\/(consult|checkout)/.test(x));
    expect(leadLinks.length).toBeGreaterThanOrEqual(10);
    for (const x of leadLinks) expect(x).toContain("from=ai-employee-corp");
    expect(hrefs).toContain("/lp/ai-employee/checkout?plan=intern&from=ai-employee-corp");
    expect(hrefs).toContain("/lp/ai-employee/consult?plan=custom&from=ai-employee-corp");
  });

  test("robots: noindex,follow; no canonical (mixed signals avoided)", () => {
    expect(corpMetadata.robots).toEqual({ index: false, follow: true });
    expect(corpMetadata.alternates?.canonical).toBeUndefined();
    expect(originalMetadata.robots).toBeUndefined();
  });

  test("B is not in any sitemap / robots allow-list", () => {
    const candidates = ["app/sitemap.ts", "app/sitemap.js", "app/sitemap.xml", "public/sitemap.xml", "app/robots.ts", "public/robots.txt"];
    for (const f of candidates) {
      if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toContain("ai-employee-corp");
    }
    for (const f of readdirSync("public")) {
      if (/^sitemap.*\.xml$/.test(f)) expect(readFileSync(`public/${f}`, "utf8")).not.toContain("ai-employee-corp");
    }
  });
});
