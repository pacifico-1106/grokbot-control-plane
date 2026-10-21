/**
 * #422 leftover L: policy stamp + LINE fail-closed lookup.
 * Flag LINE_WEB_ONLY_HIGH_RISK_ENABLED default OFF.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FLAGS = ["LINE_WEB_ONLY_HIGH_RISK_ENABLED", "LINE_WEB_ONLY_HIGH_RISK_ORG_IDS", "COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("L1: approvalTicketPolicyMetadata does not trust input approvalClass", () => {
  test("adversarial admin class on a business tool is still business", async () => {
    const { approvalTicketPolicyMetadata } = await import("@/lib/comm/line-web-only-high-risk");
    const stamped = approvalTicketPolicyMetadata({
      tool: "comm.reply",
      purpose: "comm.internal",
      employeeApprovalPolicy: "risk_based",
      metadata: { approvalClass: "admin", auditClass: "business" },
    });
    expect(stamped.approvalClass).toBe("business");
  });

  test("adversarial business class on an admin tool is still admin", async () => {
    const { approvalTicketPolicyMetadata } = await import("@/lib/comm/line-web-only-high-risk");
    const stamped = approvalTicketPolicyMetadata({
      tool: "policy.patch",
      purpose: "admin.policy",
      metadata: { approvalClass: "business", isAdminMcpTool: true, always_human: true, adminTool: "policy.patch" },
    });
    expect(stamped.approvalClass).toBe("admin");
  });
});

describe("L2: other createApproval paths stamp the 4 policy fields when the flag is ON", () => {
  test("source-lock", () => {
    for (const rel of [
      "lib/config-change-request/service.ts",
      "lib/safety/hold-actions.ts",
      "lib/approval-kind-routes/mcp-handlers.ts",
    ]) {
      const text = src(rel);
      expect({ rel, has: text.includes("approvalTicketPolicyMetadata") }).toEqual({ rel, has: true });
      expect(text).toContain("approvalPolicy");
      expect(text).toContain("employeeAlwaysHuman");
    }
  });
});

describe("L3: LINE approve does not skip the gate when getApprovalById fails", () => {
  test("source-lock: null / throw → refuse on LINE", () => {
    const wf = src("lib/approvals/workflow-integration.ts");
    expect(wf).toContain("getApprovalById");
    expect(wf).toMatch(/ticket\s*\|\|\s*!ticket|!ticket/);
    expect(wf).toContain("isLineSurfaceApproval");
    expect(wf).toContain("line_web_only");
  });
});

describe("L4: flag OFF does not add the 4 policy keys", () => {
  test("approvalTicketPolicyStamp is empty when the high-risk flag is OFF", async () => {
    const { approvalTicketPolicyStamp } = await import("@/lib/comm/line-web-only-high-risk");
    delete process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED;
    delete process.env.LINE_CONVERSATION_ENABLED;
    delete process.env.COMM_ACCOUNTS_ENABLED;
    expect(approvalTicketPolicyStamp("aaaaaaaa-0000-4000-8000-000000000307", { tool: "comm.reply" })).toEqual({});
    process.env.LINE_WEB_ONLY_HIGH_RISK_ENABLED = "true";
    const on = approvalTicketPolicyStamp("aaaaaaaa-0000-4000-8000-000000000307", {
      tool: "comm.reply",
      employeeApprovalPolicy: "risk_based",
    });
    expect(on.approvalPolicy).toBe("risk_based");
    expect(on.approvalClass).toBe("business");
    expect(Object.keys(on).sort()).toEqual(["always_human", "approvalClass", "approvalPolicy", "employeeAlwaysHuman"]);
  });

  test("invoke only spreads the stamp behind the flag", () => {
    const invoke = src("lib/gateway/invoke.ts");
    expect(invoke).toContain("approvalTicketPolicyStamp");
    expect(invoke).toContain("isLineWebOnlyHighRiskEnabled");
  });
});
