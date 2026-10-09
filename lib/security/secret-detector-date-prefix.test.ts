/**
 * Date-prefix bypass (木村, 2026-10-05): any value matching ^\d{4}-\d{2}-\d{2}
 * used to skip the whole detector. Now only a value that IS an ISO date /
 * timestamp skips; a date-led report is scanned like any other value (with the
 * #281 rules, so westjr-style URLs still pass).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { createConfigChangeRequest, type ConfigChangeDeps } from "@/lib/config-change-request/service";
import { listAuditEvents } from "@/lib/data/audit";
import { detectSecretInPayload, detectSecretInString } from "@/lib/security/secret-detector";
import { SECRET_DETECTION_BLOCKED } from "@/lib/security/secret-detection-audit";

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const AWS_EX_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_EX_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const FAKE_SECRET = "q7Vx2Lm9Pw4Rt8Ky3Hn6Bd1Fg5Jc0Ws7Te5Qa8Mz";
const SLACK_TOKEN = "xoxb-123456789012-1234567890123-abcdefghij";
const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const flagBackup = process.env[FLAG];

/** Shape of 稲盛's #icebox weekly report: date first, westjr.co.jp press URLs with long paths. */
const WEEKLY_REPORT = [
  "2026-10-05 週報（#icebox）",
  "■ 今週のトピック",
  "・JR西日本プレスリリース https://www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X.html",
  "・https://www.westjr.co.jp/press/article/items/2026/10/05/Kansai/Area/Report/Weekly/Summary2026Q4/Detail/index",
  "・www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X/AbcDef123",
  "・資料 https://docs.google.com/document/d/1aBcD3fGhIjK4LmNoP5qRsTuV6wXyZ7AbCdEfG8hIjKl/edit",
  "・commit 3f786850e387550fdab836ed7e6dc881de23001b",
  "以上",
].join("\n");

const DATE_LED_SECRETS: Array<[string, string, string]> = [
  ["AWS example pair", `2026-10-05 設定メモ\nAWS_ACCESS_KEY_ID=${AWS_EX_ID}\nAWS_SECRET_ACCESS_KEY=${AWS_EX_SECRET}`, AWS_EX_SECRET],
  ["keyword-nearby secret", `2026-10-05T09:00:00+09:00 aws secret access key は ${FAKE_SECRET} です`, FAKE_SECRET],
  ["Slack token", `2026-10-05 bot token: ${SLACK_TOKEN}`, SLACK_TOKEN.slice(5)],
];

function expectNoSubstring(haystack: string, secret: string, min = 3) {
  for (let i = 0; i + min <= secret.length; i++) {
    const part = secret.slice(i, i + min);
    if (haystack.includes(part)) throw new Error(`leaked substring ${JSON.stringify(part)}`);
  }
  expect(haystack).not.toContain(createHash("sha256").update(secret).digest("hex"));
}

describe("detector (pure)", () => {
  test("pure ISO dates / timestamps still skip", () => {
    for (const v of [
      "2026-09-22",
      " 2026-09-22 ",
      "2026-09-22T10:30:00Z",
      "2026-09-22T10:30Z",
      "2026-09-22 10:30:00",
      "2026-10-05T01:49:29.123Z",
      "2026-10-05T10:49:29.123456+09:00",
      "2026-10-05T10:49:29+0900",
    ]) {
      expect(detectSecretInString(v)).toEqual({ ok: true });
    }
  });

  test("date-prefixed values are scanned: secrets after a date are blocked", () => {
    for (const [, text] of DATE_LED_SECRETS) {
      const r = detectSecretInString(text);
      expect(r.ok).toBe(false);
    }
    expect(detectSecretInString(`2026-09-22 ${SLACK_TOKEN}`).ok).toBe(false);
    expect(detectSecretInString(`2026-09-22T10:30:00Z ${SLACK_TOKEN}`).ok).toBe(false);
    expect(detectSecretInString(`2026-09-22${SLACK_TOKEN}`).ok).toBe(false);
  });

  test("a date-led weekly report with westjr-style URLs passes under the #281 rules", () => {
    const r = detectSecretInPayload({ args: { message: WEEKLY_REPORT } });
    expect(r.ok).toBe(true);
  });
});

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
    for (const [label, text, secret] of DATE_LED_SECRETS) {
      test(`${p.name}: date-led ${label} → blocked, exactly one audit row, no value characters`, async () => {
        const jobId = uniqJob("dp-block");
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

    test(`${p.name}: the date-led weekly report with westjr URLs is not blocked`, async () => {
      const jobId = uniqJob("dp-report");
      const { blocked } = await p.run(WEEKLY_REPORT, jobId);
      expect(blocked).toBe(false);
    });

    test(`${p.name}: a pure ISO timestamp value is not blocked`, async () => {
      const jobId = uniqJob("dp-iso");
      const { blocked } = await p.run("2026-10-05T10:27:00+09:00", jobId);
      expect(blocked).toBe(false);
    });
  }
});
