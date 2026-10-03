import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_LAST_REVISED } from "./legal-revisions";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("法務ページの最終改定日", () => {
  test("各ページの最終改定日は本文変更PR（#199 / #201）が main に入った日（JST）", () => {
    expect(LEGAL_LAST_REVISED).toEqual({
      commercialTransactions: "2026年10月3日",
      terms: "2026年10月3日",
      privacy: "2026年10月3日",
    });
  });

  test("日付は既存の表記（YYYY年M月D日）に揃える", () => {
    for (const v of Object.values(LEGAL_LAST_REVISED)) {
      expect(v).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
    }
  });

  test("LegalPage は最終改定日に制定・施行日（effectiveDate）を流用しない", () => {
    const src = read("components/legal/LegalPage.tsx");
    expect(src).toContain("最終改定日: {lastRevised}");
    expect(src).not.toContain("最終改定日: {identity.effectiveDate}");
    expect(src).toContain("制定・施行日: {identity.effectiveDate}");
  });

  const pages: Array<[string, string]> = [
    ["app/legal/commercial-transactions/page.tsx", "commercialTransactions"],
    ["app/legal/terms/page.tsx", "terms"],
    ["app/legal/privacy/page.tsx", "privacy"],
  ];
  for (const [path, key] of pages) {
    test(`${path} は自ページの最終改定日を渡す`, () => {
      expect(read(path)).toContain(`lastRevised={LEGAL_LAST_REVISED.${key}}`);
    });
  }
});
