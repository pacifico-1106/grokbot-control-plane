/**
 * 2026-10-12 (木村, #327 remainder a): a lint rule that blocks new
 * NextResponse.json calls without a charset in non-test code and points to
 * jsonUtf8 (@/lib/http/json-utf8). Existing call sites are on an allowlist that
 * the mechanical replacement PR removes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint, RuleTester } from "eslint";
// @ts-expect-error -- local .mjs rule module without types
import rule from "../../eslint-rules/json-utf8.mjs";
// @ts-expect-error -- local .mjs allowlist without types
import { JSON_UTF8_LEGACY_ALLOWLIST } from "../../eslint-rules/json-utf8-allowlist.mjs";

const ROOT = join(import.meta.dir, "..", "..");

describe("rule staffpass/json-utf8 (RuleTester)", () => {
  test("valid / invalid cases", () => {
    const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });
    const errors = [{ messageId: "useJsonUtf8" }];
    tester.run("json-utf8", rule, {
      valid: [
        `jsonUtf8({ ok: true })`,
        `jsonUtf8({ ok: false }, { status: 401 })`,
        `NextResponse.json({ ok: true }, { headers: { "content-type": "application/json; charset=utf-8" } })`,
        `NextResponse.json({ ok: true }, { status: 400, headers: { "Content-Type": "application/json; charset=UTF-8" } })`,
        `NextResponse.redirect(url)`,
        `res.json()`,
        `await response.json()`,
        `other.json({})`,
      ],
      invalid: [
        { code: `NextResponse.json({ ok: true })`, errors },
        { code: `NextResponse.json({ ok: false }, { status: 401 })`, errors },
        { code: `NextResponse.json({}, { headers: { "cache-control": "no-store" } })`, errors },
        { code: `NextResponse.json({}, { headers: { "content-type": "application/json" } })`, errors },
        { code: `NextResponse.json({}, { headers: HEADERS })`, errors },
        { code: `NextResponse.json({}, init)`, errors },
        { code: `return NextResponse["json"]({})`.replace("return ", ""), errors },
      ],
    });
  });

  test("message points to jsonUtf8", () => {
    expect(String(rule.meta.messages.useJsonUtf8)).toContain("jsonUtf8");
    expect(String(rule.meta.messages.useJsonUtf8)).toContain("@/lib/http/json-utf8");
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("wired into eslint.config.mjs", () => {
  const eslint = new ESLint({ cwd: ROOT });
  const BAD = `import { NextResponse } from "next/server";\nexport function GET() {\n  return NextResponse.json({ ok: false, message: "日本語" }, { status: 401 });\n}\n`;

  test("a new non-test route with a bare NextResponse.json → error", async () => {
    const [res] = await eslint.lintText(BAD, { filePath: join(ROOT, "app/api/__lint_probe__/route.ts") });
    expect(res.messages.some((m) => m.ruleId === "staffpass/json-utf8" && m.severity === 2)).toBe(true);
  }, 60_000);

  test("test files are not checked", async () => {
    const [res] = await eslint.lintText(BAD, { filePath: join(ROOT, "app/api/__lint_probe__/route.test.ts") });
    expect(res.messages.some((m) => m.ruleId === "staffpass/json-utf8")).toBe(false);
  }, 60_000);

  test("legacy allowlist: every existing bare call site is listed, nothing else (it can only shrink)", () => {
    const offenders = [...new Set([...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "components"))]
      .filter((f) => /NextResponse\.json\(/.test(readFileSync(f, "utf8")))
      .filter((f) => !/eslint-disable-next-line staffpass\/json-utf8/.test(readFileSync(f, "utf8")) || /NextResponse\.json\(/.test(readFileSync(f, "utf8").replace(/\/\/ eslint-disable-next-line staffpass\/json-utf8[^\n]*\n[^\n]*/g, "")))
      .map((f) => relative(ROOT, f)))].sort();
    expect([...JSON_UTF8_LEGACY_ALLOWLIST].sort()).toEqual(offenders);
  });
});
