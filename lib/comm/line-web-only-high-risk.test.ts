import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  LINE_WEB_ONLY_HIGH_RISK,
  lineWebOnlyHighRiskVerdict,
} from "@/lib/comm/line-web-only-high-risk";
import { LINE_WEB_ONLY_APPROVE_JA } from "@/lib/comm/line-poc-copy";

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FLAGS = [
  "LINE_WEB_ONLY_HIGH_RISK_ENABLED",
  "LINE_WEB_ONLY_HIGH_RISK_ORG_IDS",
  "COMM_ACCOUNTS_ENABLED",
  "LINE_CONVERSATION_ENABLED",
  "COMM_ACCOUNTS_ORG_IDS",
  "LINE_CONVERSATION_ORG_IDS",
] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Admin MCP tickets as queue.ts stamps them. */
function adminTicket(tool: string) {
  return {
    tool,
    purpose: `admin.${tool}`,
    metadata: {
      adminTool: tool,
      approvalClass: "admin",
      auditClass: "admin",
      always_human: true,
      approvalPolicy: "always_human",
      employeeAlwaysHuman: false,
      isAdminMcpTool: true,
    },
  };
}

/** Gateway send ticket when the employee is always_human. */
function alwaysHumanSend(tool: string) {
  return {
    tool,
    metadata: {
      approvalPolicy: "always_human",
      employeeAlwaysHuman: true,
      always_human: true,
      approvalClass: "business",
    },
  };
}

describe("LINE web-only high-risk (until passkeys)", () => {
  test("catalog lists hold / money / secrets / policy / always_human", () => {
    const cats = new Set(LINE_WEB_ONLY_HIGH_RISK.map((x) => x.category));
    expect(cats.has("停止解除")).toBe(true);
    expect(cats.has("金銭")).toBe(true);
    expect(cats.has("秘密（資格情報）")).toBe(true);
    expect(cats.has("ポリシー変更")).toBe(true);
    expect(cats.has("always_human")).toBe(true);
    expect(LINE_WEB_ONLY_HIGH_RISK.every((x) => x.lineCanApprove === false)).toBe(true);
  });

  test("fail-first: money / credential / policy / always_human / unknown are refused", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "commerce.order", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "employees.credential.reissue", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "policy.patch", metadata: { adminTool: "policy.patch" } }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalPolicy: "always_human" } }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: null, metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "employee.hold.release", metadata: {} }).refuse).toBe(true);
  });

  test("H1: named tools are default-deny unless on the LINE allowlist with a classifiable policy", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "employees.issue", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalPolicy: "risk_based" } }).refuse).toBe(false);
  });

  test("H1: metadata always_human:true and approvalClass admin are refused", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { always_human: true, approvalPolicy: "risk_based" } }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalClass: "admin", approvalPolicy: "risk_based" } }).refuse).toBe(true);
  });

  test("H1: production-shaped admin tickets cannot be approved on LINE", () => {
    const tools = [
      "employees.issue",
      "orgs.patch",
      "parties.upsert",
      "roles.propose",
      "setup.slackAdapter.setBotToken",
      "setup.lineApproval.upsert",
      "setup.lineApproval.setEmployeeInbox",
      "setup.lineApproval.demoteTelegram",
      "employees.allowedAccounts.add",
      "employees.allowedAccounts.remove",
      "employees.retire",
    ];
    for (const tool of tools) {
      expect({ tool, v: lineWebOnlyHighRiskVerdict(adminTicket(tool)) }).toEqual({
        tool,
        v: expect.objectContaining({ refuse: true }),
      });
    }
  });

  test("H1: always_human employee send tickets cannot be approved on LINE", () => {
    for (const tool of ["comm.reply", "comm.send", "slack.post", "mail.send", "browser.use"]) {
      expect({ tool, v: lineWebOnlyHighRiskVerdict(alwaysHumanSend(tool)) }).toEqual({
        tool,
        v: expect.objectContaining({ refuse: true }),
      });
    }
  });

  test("classifiable non-high-risk tickets can stay on LINE", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalPolicy: "risk_based" } }).refuse).toBe(false);
  });

  test("refuse copy points at the web approvals page", () => {
    expect(LINE_WEB_ONLY_APPROVE_JA).toContain("Web で承認してください");
    expect(LINE_WEB_ONLY_APPROVE_JA).toContain("/app/approvals");
  });

  test("LINE postback and workflow refuse before approve", () => {
    const events = src("lib/line/approval-events.ts");
    expect(events).toContain("lineWebOnlyHighRiskVerdict");
    expect(events).toContain("isLineWebOnlyHighRiskEnabled");
    expect(events).toContain("LINE_WEB_ONLY_APPROVE_JA_OF");
    expect(events).toContain("getAppOrigin");
    expect(events).toContain("line.web_only_refused");
    expect(events).toMatch(/line_web_only_refused_audit_failed/);
    const wf = src("lib/approvals/workflow-integration.ts");
    expect(wf).toContain("lineWebOnlyHighRiskVerdict");
    expect(wf).toContain("isLineSurfaceApproval");
    expect(wf).toContain("isLineWebOnlyHighRiskEnabled");
  });

  test("H1: ticket create stamps approvalPolicy / employeeAlwaysHuman / approvalClass / always_human", () => {
    const invoke = src("lib/gateway/invoke.ts");
    expect(invoke).toMatch(/approvalTicketPolicyMetadata|employeeAlwaysHuman/);
    expect(invoke).toContain("approvalClass");
    expect(invoke).toContain("always_human");
    const queue = src("lib/admin-mcp/queue.ts");
    expect(queue).toContain("approvalPolicy");
    expect(queue).toContain("employeeAlwaysHuman");
    expect(queue).toContain("approvalClass");
    expect(queue).toContain("always_human");
  });
});

describe("L1: new LINE migrations have DB security tests registered", () => {
  test("SQL fixtures exist and test-db-local.py runs them", () => {
    expect(existsSync(join(process.cwd(), "tests/security/db-line-conversation-link-codes.sql"))).toBe(true);
    expect(existsSync(join(process.cwd(), "tests/security/db-upsert-proof-verified-voter-binding.sql"))).toBe(true);
    const py = src("scripts/test-db-local.py");
    expect(py).toContain("db-line-conversation-link-codes.sql");
    expect(py).toContain("db-upsert-proof-verified-voter-binding.sql");
  });
});

describe("M1: LINE_WEB_ONLY_HIGH_RISK_ENABLED default OFF", () => {
  test("default OFF; conversation ON forces it; org allowlist applies", async () => {
    const { isLineWebOnlyHighRiskEnabled } = await import("@/lib/comm/flags");
    delete process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED;
    delete process.env.LINE_CONVERSATION_ENABLED;
    delete process.env.COMM_ACCOUNTS_ENABLED;
    expect(isLineWebOnlyHighRiskEnabled()).toBe(false);
    expect(isLineWebOnlyHighRiskEnabled("aaaaaaaa-0000-4000-8000-000000000307")).toBe(false);
    process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED = "true";
    expect(isLineWebOnlyHighRiskEnabled()).toBe(true);
    process.env.LINE_WEB_ONLY_HIGH_RISK_ORG_IDS = "aaaaaaaa-0000-4000-8000-000000000307";
    expect(isLineWebOnlyHighRiskEnabled("aaaaaaaa-0000-4000-8000-000000000307")).toBe(true);
    expect(isLineWebOnlyHighRiskEnabled("bbbbbbbb-0000-4000-8000-000000000001")).toBe(false);
    expect(isLineWebOnlyHighRiskEnabled()).toBe(false);
    delete process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED;
    delete process.env.LINE_WEB_ONLY_HIGH_RISK_ORG_IDS;
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "true";
    expect(isLineWebOnlyHighRiskEnabled("aaaaaaaa-0000-4000-8000-000000000307")).toBe(true);
  });
});
