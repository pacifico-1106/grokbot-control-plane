/**
 * Every caller of the secret detector: a block writes exactly one
 * secret_detection.blocked audit row (org-scoped, no value / no hash), the
 * response / logs / audit never contain any 3-char substring of the secret,
 * the rejection stands when the audit write throws, no approval is created,
 * and the westjr.co.jp-style URL is not blocked.
 *
 * Paths: gateway invoke (HTTP /api/gateway/invoke and stuck-watch call
 * runGatewayInvoke), MCP staffpass_invoke, admin MCP queue (queueAdminTool:
 * every admin tool that queues), config change request (MCP staffpass_config_change_request).
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
import { listApprovals } from "@/lib/data/approvals";
import {
  SECRET_DETECTION_BLOCKED,
  SECRET_DETECTION_SUSPECTED,
  __setSecretDetectionAuditWriterForTests,
} from "@/lib/security/secret-detection-audit";

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const FAKE_SECRET = "q7Vx2Lm9Pw4Rt8Ky3Hn6Bd1Fg5Jc0Ws7Te5Qa8Mz";
const SECRET_TEXT = `週報です。AWS secret access key は ${FAKE_SECRET} です`;
const WESTJR_TEXT =
  "#icebox 週報: https://www.westjr.co.jp/press/article/2026/Q3Report/KansaiV2X.html と " +
  "https://www.westjr.co.jp/press/article/items/2026/10/05/Kansai/Area/Report/Weekly/Summary2026Q4/Detail/index を参照";
const STANDALONE_TEXT = `参考ID ${FAKE_SECRET} を確認`;
const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const flagBackup = process.env[FLAG];

let seq = 0;
function uniqJob(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function expectNoSubstring(haystack: string, secret: string, min = 3) {
  for (let i = 0; i + min <= secret.length; i++) {
    const part = secret.slice(i, i + min);
    if (haystack.includes(part)) throw new Error(`leaked substring ${JSON.stringify(part)}`);
  }
  expect(haystack).not.toContain(createHash("sha256").update(secret).digest("hex"));
  expect(haystack).not.toContain(createHash("sha1").update(secret).digest("hex"));
}

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

type PathOutcome = { blocked: boolean; out: unknown };
type PathDef = { name: string; tool: string; run: (text: string, jobId: string) => Promise<PathOutcome> };

const PATHS: PathDef[] = [
  {
    name: "gateway invoke (runGatewayInvoke)",
    tool: "slack.post",
    run: async (text, jobId) => {
      const r = await runGatewayInvoke({
        employeeId: EMP,
        credentialId: null,
        body: {
          tool: "slack.post",
          purpose: "weekly report",
          jobId,
          // A client-supplied org must never scope the audit.
          orgId: "org_attacker",
          // Client flags cannot switch the detector off.
          skipSecretScan: true,
          allowSecrets: true,
          args: { channel: "C0ICEBOX", message: text },
        } as never,
      });
      return { blocked: r.body.code === "secret_detected_in_payload", out: r.body };
    },
  },
  {
    name: "MCP staffpass_invoke",
    tool: "slack.post",
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
    name: "admin MCP queue (queueAdminTool)",
    tool: "employees.issue",
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
    tool: "config.change_request",
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

async function auditFor(action: string, jobId: string) {
  const all = await listAuditEvents(null, 100000);
  return all.filter((e) => e.action === action && (e.metadata as Record<string, unknown>)?.jobId === jobId);
}

let logs: string[] = [];
const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };

beforeEach(() => {
  logs = [];
  for (const k of Object.keys(originals) as Array<keyof typeof originals>) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
});

afterEach(() => {
  Object.assign(console, originals);
  __setSecretDetectionAuditWriterForTests(null);
  if (flagBackup === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagBackup;
});

describe("every detector path", () => {
  for (const p of PATHS) {
    describe(p.name, () => {
      test("block → exactly one org-scoped secret_detection.blocked row; no value / hash anywhere; no approval", async () => {
        const jobId = uniqJob("sd-block");
        const approvalsBefore = (await listApprovals(ORG)).length;
        const { blocked, out } = await p.run(SECRET_TEXT, jobId);
        expect(blocked).toBe(true);

        const rows = await auditFor(SECRET_DETECTION_BLOCKED, jobId);
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.orgId).toBe(ORG);
        expect(row.metadata).toMatchObject({ pattern: "aws_secret_key", tool: p.tool, jobId, matchLength: 40 });
        expect(typeof (row.metadata as Record<string, unknown>).fieldPath).toBe("string");
        expect(JSON.stringify(row)).not.toContain("org_attacker");

        expectNoSubstring(JSON.stringify(out), FAKE_SECRET);
        expectNoSubstring(JSON.stringify(row), FAKE_SECRET);
        expectNoSubstring(logs.join("\n"), FAKE_SECRET);

        const body = ((out as { structuredContent?: unknown }).structuredContent ?? out) as Record<string, unknown>;
        expect(body.redactedPreview).toBe("[redacted]");
        expect(body.retryable).toBe(false);
        expect(body.nextStep).toBe("該当箇所を外すか伏せて再送してください。誤検知と思われる場合は管理者に連絡してください。");

        // Self-approval is not involved: a block never creates an approval.
        expect((await listApprovals(ORG)).length).toBe(approvalsBefore);
      });

      test("audit write throws → still rejected (fail-closed), nothing leaks into logs", async () => {
        __setSecretDetectionAuditWriterForTests(async () => {
          throw new Error("audit store down");
        });
        const jobId = uniqJob("sd-auditfail");
        const { blocked, out } = await p.run(SECRET_TEXT, jobId);
        expect(blocked).toBe(true);
        expect((await auditFor(SECRET_DETECTION_BLOCKED, jobId)).length).toBe(0);
        expectNoSubstring(JSON.stringify(out), FAKE_SECRET);
        expectNoSubstring(logs.join("\n"), FAKE_SECRET);
      });

      test("westjr.co.jp-style URL report is not blocked", async () => {
        const jobId = uniqJob("sd-westjr");
        const { blocked } = await p.run(WESTJR_TEXT, jobId);
        expect(blocked).toBe(false);
        expect((await auditFor(SECRET_DETECTION_BLOCKED, jobId)).length).toBe(0);
      });

      test("standalone 40-char string → not blocked, one suspected row without value", async () => {
        const jobId = uniqJob("sd-suspect");
        const { blocked, out } = await p.run(STANDALONE_TEXT, jobId);
        expect(blocked).toBe(false);
        const rows = await auditFor(SECRET_DETECTION_SUSPECTED, jobId);
        expect(rows.length).toBe(1);
        expect(rows[0].orgId).toBe(ORG);
        expect(rows[0].metadata).toMatchObject({ pattern: "aws_secret_key", matchLength: 40 });
        expectNoSubstring(JSON.stringify(rows[0]), FAKE_SECRET);
        expectNoSubstring(logs.join("\n"), FAKE_SECRET);
        void out;
      });
    });
  }

  test("a secret placed in jobId is not echoed back in the response or the audit row", async () => {
    const jobId = `job aws_secret_access_key=${FAKE_SECRET}`;
    const r = await runGatewayInvoke({
      employeeId: EMP,
      credentialId: null,
      body: { tool: "slack.post", purpose: "weekly report", jobId, args: { message: "hi" } } as never,
    });
    expect(r.body.code).toBe("secret_detected_in_payload");
    expectNoSubstring(JSON.stringify(r.body), FAKE_SECRET);
    const all = await listAuditEvents(null, 100000);
    for (const e of all.filter((x) => x.action === SECRET_DETECTION_BLOCKED)) {
      expectNoSubstring(JSON.stringify(e), FAKE_SECRET);
    }
  });
});
