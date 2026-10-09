/**
 * 木村 2026-10-09 B: the tenant's sensitive-topic list is readable (read-only)
 * from the employee MCP — staffpass_sensitive_topics, listed only while
 * APPROVAL_REASONS_ENABLED is ON. Org comes from the credential only; there is
 * no way to change the list from this tool.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getOrgApprovalKindRoutesPolicy, setOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import type { OrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/types";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { DEMO_ORG } from "@/lib/demo-data";
import { callStaffpassMcpTool, listStaffpassMcpTools } from "@/lib/mcp/tools";

const FLAG = "APPROVAL_REASONS_ENABLED";
const TOPIC_FLAG = "P1_TOPIC_GATED_POSTING_ENABLED";
const TOOL = "staffpass_sensitive_topics";
const OTHER_ORG = "org_sensitive_topics_other";
const OTHER_TOPIC = "他社の極秘案件ABC";
const saved: Record<string, string | undefined> = {};

function policy(orgId: string, topics: string[], enabled = true): OrgApprovalKindRoutesPolicy {
  return {
    version: 1,
    policyId: `pol_${orgId}`,
    policyName: "test",
    routes: [],
    topicGate: { enabled, sensitiveTopics: topics, mainBoardChannelIds: ["C_BOARD1"] },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function cred(orgId: string, employeeId = "emp_comm"): ResolvedEmployeeCredential {
  return { employeeId, orgId, credentialId: `cred_${employeeId}`, generation: 1, fingerprint: "fixture", secretPrefix: "gb_emp_fixture", binding: null };
}

const data = (r: { structuredContent?: unknown }) => (r.structuredContent ?? {}) as Record<string, unknown>;

beforeEach(async () => {
  for (const k of [FLAG, TOPIC_FLAG]) saved[k] = process.env[k];
  process.env[FLAG] = "true";
  process.env[TOPIC_FLAG] = "true";
  await setOrgApprovalKindRoutesPolicy(DEMO_ORG.id, policy(DEMO_ORG.id, ["支払", "金額"]));
  await setOrgApprovalKindRoutesPolicy(OTHER_ORG, policy(OTHER_ORG, [OTHER_TOPIC]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("staffpass_sensitive_topics", () => {
  test("listed (read-only, no input) while the flag is ON; absent while OFF", () => {
    const tool = listStaffpassMcpTools().find((t) => t.name === TOOL);
    expect(tool).toBeTruthy();
    expect(tool!.inputSchema.properties).toEqual({});
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    expect(tool!.description).toMatch(/read-only/i);
    delete process.env[FLAG];
    expect(listStaffpassMcpTools().some((t) => t.name === TOOL)).toBe(false);
  });

  test("returns this org's list, whether the gate is active, and the note that the AI cannot change it", async () => {
    const r = await callStaffpassMcpTool(TOOL, {}, cred(DEMO_ORG.id));
    expect(r.isError).toBe(false);
    const d = data(r);
    expect(d.ok).toBe(true);
    expect(d.readOnly).toBe(true);
    const gate = d.topicGate as Record<string, unknown>;
    expect(gate.sensitiveTopics).toEqual(["支払", "金額"]);
    expect(gate.active).toBe(true);
    expect(String(d.noteJa)).toContain("変更できません");
  });

  test("gate flag OFF or org gate disabled → active false (list still shown as configured)", async () => {
    delete process.env[TOPIC_FLAG];
    expect((data(await callStaffpassMcpTool(TOOL, {}, cred(DEMO_ORG.id))).topicGate as Record<string, unknown>).active).toBe(false);
    process.env[TOPIC_FLAG] = "true";
    await setOrgApprovalKindRoutesPolicy(DEMO_ORG.id, policy(DEMO_ORG.id, ["支払"], false));
    const gate = data(await callStaffpassMcpTool(TOOL, {}, cred(DEMO_ORG.id))).topicGate as Record<string, unknown>;
    expect(gate.active).toBe(false);
    expect(gate.sensitiveTopics).toEqual(["支払"]);
  });

  test("BOLA: the org comes from the credential; an orgId argument is ignored; never another org's topics", async () => {
    const r = await callStaffpassMcpTool(TOOL, { orgId: OTHER_ORG }, cred(DEMO_ORG.id));
    expect(JSON.stringify(data(r))).not.toContain(OTHER_TOPIC);
    const other = await callStaffpassMcpTool(TOOL, {}, cred(OTHER_ORG));
    expect((data(other).topicGate as Record<string, unknown>).sensitiveTopics).toEqual([OTHER_TOPIC]);
    expect(JSON.stringify(data(other))).not.toContain("支払");
  });

  test("read-only: passing a new list does not change the policy", async () => {
    await callStaffpassMcpTool(TOOL, { sensitiveTopics: [], topicGate: { enabled: false } }, cred(DEMO_ORG.id));
    const after = await getOrgApprovalKindRoutesPolicy(DEMO_ORG.id);
    expect(after?.topicGate?.sensitiveTopics).toEqual(["支払", "金額"]);
    expect(after?.topicGate?.enabled).toBe(true);
  });

  test("no topic gate configured → empty list, configured false", async () => {
    const r = await callStaffpassMcpTool(TOOL, {}, cred("org_sensitive_topics_unconfigured"));
    const gate = data(r).topicGate as Record<string, unknown>;
    expect(gate.configured).toBe(false);
    expect(gate.sensitiveTopics).toEqual([]);
    expect(gate.active).toBe(false);
  });

  test("flag OFF → the call is refused (tool_disabled), no list", async () => {
    delete process.env[FLAG];
    const r = await callStaffpassMcpTool(TOOL, {}, cred(DEMO_ORG.id));
    expect(r.isError).toBe(true);
    expect(data(r).code).toBe("tool_disabled");
    expect(JSON.stringify(data(r))).not.toContain("支払");
  });
});

describe("docs/mcp.md + tool descriptions: Slack is auto-sent; re-run only on reinvoke_with_approvalId", () => {
  test("docs/mcp.md no longer tells the AI to always re-run with approvalId", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync("docs/mcp.md", "utf8");
    expect(doc).not.toContain("承認後は `staffpass_get_approval_status` で `approved` を確認し、同じ `jobId` で `staffpass_invoke` に `approvalId` を付けて再実行します。");
    expect(doc).toContain("`fulfilled`");
    expect(doc).toContain("`reinvokeReason`");
    expect(doc).toContain("reinvoke_with_approvalId");
  });

  test("staffpass_invoke / approvalId descriptions match", () => {
    const tools = listStaffpassMcpTools();
    const inv = tools.find((t) => t.name === "staffpass_invoke")!;
    expect(inv.description).not.toContain("Re-invoke with approvalId after status=approved.");
    expect(inv.description).toContain("pollHint=fulfilled");
    expect(inv.description).toContain("reinvoke_with_approvalId");
    const approvalIdDesc = String((inv.inputSchema.properties.approvalId as { description: string }).description);
    expect(approvalIdDesc).toContain("reinvoke_with_approvalId");
    const status = tools.find((t) => t.name === "staffpass_get_approval_status")!;
    expect(status.description).toContain("do not re-invoke");
  });
});
