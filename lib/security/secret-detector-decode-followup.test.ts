/**
 * #281 follow-up (木村 2026-10-05): detection must not be weaker than main.
 *
 * 1. Named patterns run on the raw value AND on a normalized form: %XX
 *    percent-decoded over the whole value (≤2 passes, malformed sequences never
 *    throw) and literal backslash escapes (\n \t \r, and JSON's \/) replaced.
 *    `%20sk-…`, `token%3Dsk-…`, `\nsk-…`, `id%3DAKIA…` used to slip past the
 *    left boundary.
 * 2. The 40-char AWS secret also takes `secret` / シークレット / 秘密 / アクセスキー
 *    as context (except for a run that is part of a URL host/path).
 * (Item 3, separator-less forms, and item 4, audit minor points, are NOT in
 * this PR.)
 *
 * Plus negatives: ordinary percent-encoded URLs, Japanese prose with 秘密 /
 * シークレット and no key, dates, and 稲盛's #icebox weekly report shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { createConfigChangeRequest, type ConfigChangeDeps } from "@/lib/config-change-request/service";
import { listAuditEvents } from "@/lib/data/audit";
import { detectSecretInPayload, detectSecretInString } from "@/lib/security/secret-detector";
import { SECRET_DETECTION_BLOCKED } from "@/lib/security/secret-detection-audit";

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const flagBackup = process.env[FLAG];

/** OpenAI-style key: sk- + 24 alnum (fake). */
const SK = "sk-Q7vX2lM9pW4rT8kY3hN6bD1f";
const AWS_EX_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_EX_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const FAKE_SECRET = "q7Vx2Lm9Pw4Rt8Ky3Hn6Bd1Fg5Jc0Ws7Te5Qa8Mz";
const DOCS_ID_44 = "1aBcD3fGhIjK4LmNoP5qRsTuV6wXyZ7AbCdEfG8hIjKl";

function expectNoSubstring(haystack: string, secret: string, min = 3) {
  for (let i = 0; i + min <= secret.length; i++) {
    const part = secret.slice(i, i + min);
    if (haystack.includes(part)) throw new Error(`leaked substring ${JSON.stringify(part)}`);
  }
  expect(haystack).not.toContain(createHash("sha256").update(secret).digest("hex"));
}

function blockedAs(value: string, pattern: string | string[]) {
  const r = detectSecretInPayload({ args: { message: value } });
  if (r.ok) throw new Error(`expected block (${String(pattern)}) for case #${value.length}`);
  expect(Array.isArray(pattern) ? pattern : [pattern]).toContain(r.pattern);
  // The result never carries value characters.
  expect(r.redactedPreview).toBe("[redacted]");
  return r;
}

function passes(payload: unknown) {
  const r = detectSecretInPayload(payload);
  expect(r.ok).toBe(true);
  return r;
}

// ---------------------------------------------------------------------------
describe("item 1: percent-decoding and literal escapes before named patterns", () => {
  test("sk- after %20 / token%3D / %2C / double-encoded %253D", () => {
    blockedAs(`msg%20${SK}`, "openai_key");
    blockedAs(`token%3D${SK}`, "openai_key");
    blockedAs(`https://example.com/cb?token%3D${SK}`, "openai_key");
    blockedAs(`a%2C${SK}`, "openai_key");
    blockedAs(`token%253D${SK}`, "openai_key");
    // The prefix itself percent-encoded.
    blockedAs(`key%3Dsk%2D${SK.slice(3)}`, "openai_key");
  });

  test("sk- right after a literal backslash escape (\\n, \\t, \\r)", () => {
    blockedAs(`line1\\n${SK}`, "openai_key");
    blockedAs(`col\\t${SK}`, "openai_key");
    blockedAs(`end\\r\\n${SK}`, "openai_key");
    blockedAs(`{"text":"見て\\n${SK}"}`, "openai_key");
  });

  test("AKIA access key id after id%3D / a literal \\n / a percent-encoded BOM", () => {
    blockedAs(`id%3D${AWS_EX_ID}`, "aws_access_key");
    blockedAs(`https://s3.example.com/obj?X-Amz-Credential%3D${AWS_EX_ID}%2F20261005`, "aws_access_key");
    blockedAs(`id:\\n${AWS_EX_ID}`, "aws_access_key");
    blockedAs(`id%EF%BB%BF${AWS_EX_ID}`, "aws_access_key");
  });

  test("an id found only after decoding still gives AWS context to a secret elsewhere in the payload", () => {
    const r = detectSecretInPayload({ a: `ref id%3D${AWS_EX_ID}`, b: `value ${FAKE_SECRET} end` });
    expect(r.ok).toBe(false);
  });

  test("AWS secret whose keyword is percent-encoded (aws%5Fsecret%5Faccess%5Fkey)", () => {
    blockedAs(`aws%5Fsecret%5Faccess%5Fkey%3D${encodeURIComponent(AWS_EX_SECRET)}`, "aws_secret_key");
    // JSON-escaped slashes inside the key.
    blockedAs(`"aws_secret_access_key":"${AWS_EX_SECRET.replace(/\//g, "\\/")}"`, "aws_secret_key");
  });

  test("malformed percent sequences never throw and fall back safely", () => {
    for (const v of ["100%", "%", "%%%", "%ZZ", "50%OFF", "%E3%81", "%E7%A7%98%E5%AF", "%C0%AF", "%FF%FE", "a%2", "%u0041"]) {
      expect(() => detectSecretInString(v)).not.toThrow();
      expect(detectSecretInString(v).ok).toBe(true);
    }
    // A broken UTF-8 byte sequence right before a key does not hide it.
    blockedAs(`%E3%81${SK}`, "openai_key");
    blockedAs(`%E3%81 token%3D${SK}`, "openai_key");
    // The raw value is always scanned too.
    blockedAs(`%ZZ ${SK}`, "openai_key");
  });

  test("ReDoS / size: pathological percent and escape input stays fast", () => {
    const evil = [
      "%".repeat(200_000),
      "%2".repeat(100_000),
      "%25".repeat(70_000),
      "\\".repeat(200_000),
      "\\n".repeat(100_000),
      "sk-".repeat(70_000),
      "akia".repeat(50_000),
      "apikey".repeat(35_000),
      "a1B2".repeat(50_000) + "!",
    ];
    for (const v of evil) {
      const t0 = performance.now();
      expect(() => detectSecretInString(v)).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });

  test("length cap: a value over the scan cap is refused (fail-closed), without value characters", () => {
    const huge = "あ".repeat(1_000_001);
    const r = detectSecretInString(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pattern).toBe("value_too_long_to_scan");
      expect(r.redactedPreview).toBe("[redacted]");
    }
  });
});

// ---------------------------------------------------------------------------
describe("item 2: secret / シークレット / 秘密 / アクセスキー as AWS secret context", () => {
  test("blocked (was only 'suspected')", () => {
    blockedAs(`secret: ${AWS_EX_SECRET}`, "aws_secret_key");
    blockedAs(`AWSのシークレットキーは ${AWS_EX_SECRET} です`, "aws_secret_key");
    blockedAs(`秘密のキー: ${FAKE_SECRET}`, "aws_secret_key");
    blockedAs(`アクセスキーとペアの値 ${AWS_EX_SECRET}`, "aws_secret_key");
    blockedAs(`${AWS_EX_SECRET} はシークレットです`, "aws_secret_key");
    blockedAs(`Secret ${AWS_EX_SECRET}`, "aws_secret_key");
    // Percent-encoded Japanese keyword (秘密 = %E7%A7%98%E5%AF%86).
    blockedAs(`%E7%A7%98%E5%AF%86%3D${encodeURIComponent(AWS_EX_SECRET)}`, "aws_secret_key");
  });

  test("keyword in the field path", () => {
    const r = detectSecretInPayload({ cfg: { clientSecret: AWS_EX_SECRET } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.pattern).toBe("aws_secret_key");
  });

  test("the keyword window is still bounded (100 before / 30 after)", () => {
    const far = `秘密${"。".repeat(120)}${FAKE_SECRET}`;
    const r = detectSecretInPayload({ message: far });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suspected?.[0]?.pattern).toBe("aws_secret_key");
  });
});

// ---------------------------------------------------------------------------
/** 稲盛's #icebox weekly report shape (from #283) */
const WEEKLY_REPORT = [
  "2026-10-05 週報（#icebox）",
  "■ 今週のトピック",
  "・JR西日本プレスリリース https://www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X.html",
  "・https://www.westjr.co.jp/press/article/items/2026/10/05/Kansai/Area/Report/Weekly/Summary2026Q4/Detail/index",
  "・www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X/AbcDef123",
  `・資料 https://docs.google.com/document/d/${DOCS_ID_44}/edit`,
  "・commit 3f786850e387550fdab836ed7e6dc881de23001b",
  "以上",
].join("\n");

/** Same shape with percent-encoded URLs, literal \n escapes and 秘密 / シークレット prose (no key). */
const WEEKLY_REPORT_JA_SECRET_WORDS = [
  "2026-10-05 週報（#icebox）\\n",
  "■ 秘密保持契約（NDA）の更新とシークレット管理の棚卸し",
  "・JR西日本プレスリリース https://www.westjr.co.jp/press%2Farticle%2F2026%2FQ3Report%2FKansaiV2X.html",
  "・秘密: 検索 https://www.google.com/search?q=%E7%A7%98%E5%AF%86%E4%BF%9D%E6%8C%81%E5%A5%91%E7%B4%84&hl=ja",
  "・https://ja.wikipedia.org/wiki/%E3%82%B7%E3%83%BC%E3%82%AF%E3%83%AC%E3%83%83%E3%83%88",
  "・アクセスキーのローテーション手順 www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X/AbcDef123",
  `・シークレット運用メモ https://docs.google.com/document/d/${DOCS_ID_44}/edit?usp=sharing`,
  "・commit 3f786850e387550fdab836ed7e6dc881de23001b（secret rotation）",
  "以上",
].join("\n");

describe("negatives: no new false positives", () => {
  test("稲盛's #icebox weekly report (and a variant with 秘密 / シークレット / encoded URLs) passes", () => {
    passes({ args: { message: WEEKLY_REPORT } });
    passes({ args: { message: WEEKLY_REPORT_JA_SECRET_WORDS } });
  });

  test("ordinary percent-encoded URLs", () => {
    for (const url of [
      "https://www.google.com/search?q=%E6%9D%B1%E4%BA%AC%E3%80%80%E5%A4%A9%E6%B0%97",
      "https://ja.wikipedia.org/wiki/%E7%A7%98%E5%AF%86",
      "https://example.com/a%2Fb%2Fc?redirect=https%3A%2F%2Fexample.com%2Fcallback%3Fx%3D1%26y%3D2",
      "https://www.westjr.co.jp/press/article/2026/Q3Report/Kansai%20V2X.html",
      "https://www.westjr.co.jp/press%2Farticle%2F2026%2FQ3Report%2FKansaiV2X.html",
      `https://docs.google.com/document/d/${DOCS_ID_44}/edit?usp=sharing&ts=%3D1`,
      "https://maps.google.com/?q=%E5%A4%A7%E9%98%AA%E9%A7%85&ll=34.70%2C135.49",
      "https://example.co.jp/news?title=%E3%82%B7%E3%83%BC%E3%82%AF%E3%83%AC%E3%83%83%E3%83%88%E7%AE%A1%E7%90%86&page=2",
      "mailto:info@example.co.jp?subject=%E7%A7%98%E5%AF%86%E4%BF%9D%E6%8C%81",
    ]) {
      expect(detectSecretInString(url).ok).toBe(true);
      passes({ message: `参考: ${url} を確認` });
    }
  });

  test("Japanese prose with 秘密 / シークレット / アクセスキー and no key", () => {
    for (const v of [
      "この件は社外秘密です。シークレットキーの管理方法は来週の会議で議論します。",
      "アクセスキーのローテーションは完了しました。秘密情報はチャットに貼らないでください。",
      "秘密保持契約書 https://www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X.html を確認",
      "シークレット: なし（Vault で管理）",
      "secret santa の抽選は 12/20 です",
      "秘密の部屋 abcdefghijklmnopqrstuvwxyzabcdefghijklmn は小文字だけ",
      "シークレット commit 3f786850e387550fdab836ed7e6dc881de23001b",
      "改行の\\nエスケープと\\tタブ、C:\\new\\temp\\report.txt",
    ]) {
      passes({ message: v });
    }
  });

  test("dates (plain, percent-encoded, Japanese)", () => {
    for (const v of [
      "2026-10-05",
      "2026-10-05T10:27:00+09:00",
      "2026%2D10%2D05",
      "2026-10-05T10%3A27%3A00%2B09%3A00",
      "期限: 2026/10/05 10:27",
      "2026年10月5日（月）",
      "20261005T102700Z",
      "2026-10-05 秘密保持契約の締結日",
    ]) {
      expect(detectSecretInString(v).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
function empCred(): ResolvedEmployeeCredential {
  return {
    employeeId: EMP,
    orgId: ORG,
    credentialId: `cred_${EMP}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId: EMP,
      orgId: ORG,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function adminCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return {
    orgId: ORG,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

const okDeps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async () => true,
};

const PATHS: Array<{ name: string; run: (text: string, jobId: string) => Promise<{ blocked: boolean; out: unknown }> }> = [
  {
    name: "gateway invoke",
    run: async (text, jobId) => {
      const r = await runGatewayInvoke({
        employeeId: EMP,
        credentialId: null,
        body: { tool: "slack.post", purpose: "weekly report", jobId, args: { channel: "C0ICEBOX", message: text } } as never,
      });
      return { blocked: r.body.code === "secret_detected_in_payload", out: r.body };
    },
  },
  {
    name: "MCP staffpass_invoke",
    run: async (text, jobId) => {
      const r = await callStaffpassMcpTool(
        "staffpass_invoke",
        { tool: "slack.post", purpose: "weekly report", jobId, payload: { channel: "C0ICEBOX", message: text } },
        empCred()
      );
      const data = r.structuredContent as Record<string, unknown>;
      return { blocked: data.code === "secret_detected_in_payload", out: r };
    },
  },
  {
    name: "admin queue",
    run: async (text, jobId) => {
      const r = await queueAdminTool({
        cred: adminCred(),
        tool: "employees.issue",
        args: { displayName: "Test AI", roleLabel: text, scopes: ["tools:read"] },
        summary: "issue",
        jobId,
      });
      return { blocked: r.code === "secret_detected_in_payload", out: r };
    },
  },
  {
    name: "config change request",
    run: async (text, jobId) => {
      process.env[FLAG] = "1";
      const r = await createConfigChangeRequest(
        {
          orgId: ORG,
          employeeId: EMP,
          credentialId: `cred_${EMP}`,
          args: {
            kind: "instructions",
            jobId,
            requestedBy: { name: "稲盛", slackUserId: "U0INAMORI" },
            reason: text,
            instructions: { mode: "append", text: "週報は月曜に投稿する。" },
          },
        },
        okDeps
      );
      return { blocked: r.code === "secret_detected_in_payload", out: r };
    },
  },
];

const PATH_SECRETS: Array<[string, string, string]> = [
  ["token%3Dsk- (item 1)", `週報 token%3D${SK} です`, SK.slice(3)],
  ["literal \\n then AKIA (item 1)", `メモ\\n${AWS_EX_ID}`, AWS_EX_ID.slice(4)],
  ["AWSのシークレットキー (item 2)", `AWSのシークレットキーは ${AWS_EX_SECRET} です`, AWS_EX_SECRET],
  ["secret: <AWS key> (item 2)", `設定 secret: ${AWS_EX_SECRET}`, AWS_EX_SECRET],
];

let seq = 0;
const uniqJob = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
let logs: string[] = [];
const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };

beforeEach(() => {
  logs = [];
  for (const k of Object.keys(originals) as Array<keyof typeof originals>) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});
afterEach(() => {
  Object.assign(console, originals);
  if (flagBackup === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagBackup;
});

describe("every detector path", () => {
  for (const p of PATHS) {
    for (const [label, text, secret] of PATH_SECRETS) {
      test(`${p.name}: ${label} → blocked, exactly one org-scoped audit row, no value characters`, async () => {
        const jobId = uniqJob("fu-block");
        const { blocked, out } = await p.run(text, jobId);
        expect(blocked).toBe(true);
        const rows = (await listAuditEvents(null, 100000)).filter(
          (e) => e.action === SECRET_DETECTION_BLOCKED && (e.metadata as Record<string, unknown>)?.jobId === jobId
        );
        expect(rows.length).toBe(1);
        expect(rows[0].orgId).toBe(ORG);
        expectNoSubstring(JSON.stringify(out), secret);
        expectNoSubstring(JSON.stringify(rows[0]), secret);
        expectNoSubstring(logs.join("\n"), secret);
      });
    }

    test(`${p.name}: the #icebox weekly report and its 秘密/シークレット/encoded-URL variant are not blocked`, async () => {
      for (const report of [WEEKLY_REPORT, WEEKLY_REPORT_JA_SECRET_WORDS]) {
        const jobId = uniqJob("fu-report");
        const { blocked } = await p.run(report, jobId);
        expect(blocked).toBe(false);
      }
    });
  }
});
