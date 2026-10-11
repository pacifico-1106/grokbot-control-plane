import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OriginalPage from "@/app/lp/ai-employee/page";
import CorpPage from "@/app/lp/ai-employee-corp/page";

/**
 * 八坂さん 10/12 07:48: the architecture diagram's 「AI実行環境」 card on A and B
 * (shared ARCHITECTURE source) is 「AIエージェント」 with the new description.
 */
const NEW_TITLE = "AIエージェント";
const SUBTITLE = "AI実行環境";
const NEW_DESC = "専用の実行環境でAI社員が稼働。権限の範囲内で業務を遂行し、Staffpassが最後の砦として制御します。";

/** The <article> card whose subtitle is 「AI実行環境」, as visible text. */
function card(html: string): string {
  const articles = html.match(/<article\b[\s\S]*?<\/article>/g) ?? [];
  const hits = articles.filter((a) => a.includes(`>${SUBTITLE}<`));
  expect(hits).toHaveLength(1);
  return hits[0].replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean).join("|");
}

const pages = [
  ["A /lp/ai-employee", () => renderToStaticMarkup(OriginalPage() as ReactElement)],
  ["B /lp/ai-employee-corp", () => renderToStaticMarkup(CorpPage() as ReactElement)],
] as const;

describe("architecture card 「AI実行環境」", () => {
  for (const [name, render] of pages) {
    test(`${name}: heading AIエージェント, subtitle kept, new description`, () => {
      const c = card(render());
      expect(c).toBe(`03|${NEW_TITLE}|${SUBTITLE}|${NEW_DESC}`);
    });
    test(`${name}: old heading / old description gone from the card`, () => {
      const c = card(render());
      expect(c).not.toMatch(/Grok/i);
      expect(c).not.toMatch(/Cursor/i);
      expect(c).not.toContain("Cursorベースの実行環境で");
    });
  }
  test("shared source: the card is defined once (A and B share it)", () => {
    const src = readFileSync("app/lp/ai-employee/AIEmployeeLanding.tsx", "utf8");
    expect(src.split(`subtitle: "${SUBTITLE}"`)).toHaveLength(2);
    expect(src).toContain(`title: "${NEW_TITLE}"`);
  });
});
