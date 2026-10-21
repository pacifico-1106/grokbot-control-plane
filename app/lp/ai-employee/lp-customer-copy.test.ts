import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OriginalPage, { metadata as originalMetadata } from "@/app/lp/ai-employee/page";
import CorpPage, { metadata as corpMetadata } from "@/app/lp/ai-employee-corp/page";
import { AIEmployeeLanding } from "@/app/lp/ai-employee/AIEmployeeLanding";

/**
 * Customer-facing LP copy: Staffpass does not depend on a specific execution product.
 * Recommended environment is Cursor (various agents can be used through it).
 * Architecture card heading stays 「AIエージェント」.
 */
const LP_ROOT = "app/lp";
const SKIP_DIRS = new Set(["node_modules", "__fixtures__"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".json", ".md", ".html"]);
const ENV = ["LP_CHAT_ENABLED", "LP_HANDOFF_ENABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(rel, out);
    else if (TEXT_EXT.has(extname(entry.name)) && statSync(rel).size < 2_000_000) out.push(rel);
  }
  return out;
}

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("LP customer copy: no Grok Bot; 推奨：Cursor", () => {
  test("LP sources (excluding fixtures) do not mention Grok Bot", () => {
    const self = "app/lp/ai-employee/lp-customer-copy.test.ts";
    const hits: string[] = [];
    for (const file of walk(LP_ROOT)) {
      if (file === self) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/Grok\s*Bot/i.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("rendered A/B HTML and metadata use 推奨：Cursor, not Grok Bot", () => {
    delete process.env.LP_CHAT_ENABLED;
    delete process.env.LP_HANDOFF_ENABLED;
    const pages = [
      html(OriginalPage() as ReactElement),
      html(CorpPage() as ReactElement),
      html(createElement(AIEmployeeLanding, { variant: "ai-employee" })),
      html(createElement(AIEmployeeLanding, { variant: "ai-employee-corp" })),
    ];
    for (const h of pages) {
      expect(h).not.toMatch(/Grok\s*Bot/i);
      expect(h).toContain("推奨：Cursor");
      expect(h).not.toContain("ワンクリックで承認");
      expect(h).toContain("Slackのボタンで承認・却下できます。");
      expect(h).toContain("LINE／LINE WORKSは対応予定");
      expect(h).not.toContain("LINEのボタンで承認");
      expect(h).not.toContain("LINE・Slackではボタン");
      expect(h).not.toContain("LINE・Slackのボタン");
      expect(h).not.toContain("メール・LINE・Slackで承認");
      expect(h).not.toContain("メール / LINE / Slack");
      expect(h).toContain("提供予定（オプション、従量課金）");
      expect(h).toContain("電話応対オプション");
      expect(h).not.toMatch(/Twilio/i);
    }
    const metas = [originalMetadata, corpMetadata];
    for (const m of metas) {
      expect(String(m.description)).not.toMatch(/Grok\s*Bot/i);
      expect(String(m.description)).toContain("推奨：Cursor");
    }
  });

  test("architecture card heading stays AIエージェント (product-agnostic)", () => {
    const src = readFileSync("app/lp/ai-employee/AIEmployeeLanding.tsx", "utf8");
    expect(src).toContain('title: "AIエージェント"');
    expect(src).toContain('subtitle: "AI実行環境"');
  });
});
