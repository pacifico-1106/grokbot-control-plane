import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { SERVICE_LABEL, SERVICE_LABEL_EN } from "./brand";
import { getEmailFrom, renderStubHtml } from "./resend";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("サービス表記（Staffpass（AIエージェントの社員証））", () => {
  test("表記の定数", () => {
    expect(SERVICE_LABEL).toBe("Staffpass（AIエージェントの社員証）");
    expect(SERVICE_LABEL_EN).toBe("Staffpass — ID badges for AI agents");
  });

  test("メール: EMAIL_FROM 未設定時の既定の差出人名は新しい表記", () => {
    const prev = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    try {
      expect(getEmailFrom()).toBe(`${SERVICE_LABEL} <noreply@example.com>`);
    } finally {
      if (prev !== undefined) process.env.EMAIL_FROM = prev;
    }
  });

  test("メール: EMAIL_FROM が設定されていればそれを優先する（本番の値はコードでは変えない）", () => {
    const prev = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = "X <x@example.com>";
    try {
      expect(getEmailFrom()).toBe("X <x@example.com>");
    } finally {
      if (prev === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = prev;
    }
  });

  test("メール: 本文フッターは新しい表記で、旧表記を含まない", () => {
    const html = renderStubHtml("件名", "<p>本文</p>");
    expect(html).toContain(SERVICE_LABEL);
    expect(html).not.toContain("Grok Bot");
  });

  test("特商法: サービス名は新しい表記", () => {
    expect(read("app/legal/commercial-transactions/page.tsx")).toContain(
      "<tr><th>サービス名</th><td>Staffpass（AIエージェントの社員証）</td></tr>",
    );
  });

  test("利用規約: 前文の「別名」を新しい表記に置き換える", () => {
    const src = read("app/legal/terms/page.tsx");
    expect(src).toContain("Staffpass（AIエージェントの社員証。以下「本サービス」といいます。）");
    expect(src).not.toContain("別名");
  });

  test(".env.example の EMAIL_FROM 例は新しい表記", () => {
    expect(read(".env.example")).toContain(
      `EMAIL_FROM=${SERVICE_LABEL} <noreply@your-verified-domain.com>`,
    );
  });

  test("package.json / server-card の英語説明は新しい表記", () => {
    const pkg = JSON.parse(read("package.json")) as { description: string };
    expect(pkg.description.startsWith(SERVICE_LABEL_EN)).toBe(true);
    const card = JSON.parse(read("public/.well-known/mcp/server-card.json")) as {
      description: string;
    };
    expect(card.description.startsWith(`Staffpass remote MCP — ID badges for AI agents.`)).toBe(true);
    expect(card.description).not.toMatch(/for Grok Bot/i);
  });
});

// 旧表記がリポジトリに残っていないことを確認する（意図して残す箇所は許可リスト）。
const OLD_LABEL_PATTERNS: RegExp[] = [
  /AI\s?社員\s?for\s?Grok\s?Bot/i,
  /説明できる\s?AI\s?社員\s?—\s?for\s?Grok\s?Bot/i,
  /control plane for Grok\s?Bot/i,
  /for\s?Grok\s?Bot/i,
];

// [ファイル, 行に含まれる文字列]。Grok Bot との接続や技術的な事実を述べる箇所だけ。
const ALLOWED: Array<[string, string]> = [
  ["public/.well-known/mcp/server-card.json", "no local stdio for Grok Bot Plugins"],
  ["lib/employees/policy-draft.ts", "scopes rewritten for Grok Bot"],
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage", "dist", "build"]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".mdx", ".html", ".css",
  ".sql", ".txt", ".yml", ".yaml", ".toml", ".svg", ".example", "",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(rel, out);
    else if (TEXT_EXT.has(extname(entry.name)) && statSync(join(ROOT, rel)).size < 2_000_000) {
      out.push(rel);
    }
  }
  return out;
}

describe("旧表記の残存チェック", () => {
  test("許可リスト以外に旧表記（AI社員 for Grok Bot / for Grok Bot 等）が残っていない", () => {
    const self = "lib/brand.test.ts";
    const hits: string[] = [];
    for (const file of walk("")) {
      if (file === self) continue;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!OLD_LABEL_PATTERNS.some((re) => re.test(line))) return;
        if (ALLOWED.some(([f, s]) => f === file && line.includes(s))) return;
        hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("許可リストの箇所は実在する（古くなった許可を残さない）", () => {
    for (const [file, s] of ALLOWED) {
      expect(read(file)).toContain(s);
    }
  });
});
