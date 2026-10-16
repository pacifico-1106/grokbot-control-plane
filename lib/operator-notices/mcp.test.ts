/**
 * PR-B: employee MCP list / ack / whoami counts. Flag OFF → tools/list is the
 * same array object as STAFFPASS_MCP_TOOLS. Cross-org ids are not_found.
 * Notice text is untrusted (guardJa always present). Gateway does not read it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { DEMO_ORG } from "@/lib/demo-data";
import { STAFFPASS_MCP_TOOLS, callStaffpassMcpTool, listStaffpassMcpTools } from "@/lib/mcp/tools";
import { OPERATOR_NOTICES_GUARD_JA, OPERATOR_NOTICES_WHOAMI_RULE_JA } from "./copy";
import { __registerDemoEmployee, __resetDemoOperatorNotices, __seedDemoNotice } from "./store";
import { NOTICES_ACK_TOOL, NOTICES_LIST_TOOL } from "./service";

const FLAG = "OPERATOR_NOTICES_ENABLED";
const PILOT = "OPERATOR_NOTICES_PILOT_ORG_IDS";
const saved: Record<string, string | undefined> = {};

const ORG_A = "org_notices_a";
const ORG_B = "org_notices_b";
const EMP_A = "emp_notices_a";
const EMP_B = "emp_notices_b";

function cred(orgId: string, employeeId: string): ResolvedEmployeeCredential {
  return {
    employeeId,
    orgId,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    fingerprint: "fixture",
    secretPrefix: "gb_emp_fixture",
    binding: null,
  };
}

function data(r: { structuredContent?: unknown }) {
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  saved[FLAG] = process.env[FLAG];
  saved[PILOT] = process.env[PILOT];
  process.env[FLAG] = "true";
  delete process.env[PILOT];
  __resetDemoOperatorNotices();
  __registerDemoEmployee(EMP_A, ORG_A);
  __registerDemoEmployee(EMP_B, ORG_B);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetDemoOperatorNotices();
});

describe("tools/list identity when the flag is OFF", () => {
  test("unset flag → listStaffpassMcpTools() is the same array as STAFFPASS_MCP_TOOLS", () => {
    delete process.env[FLAG];
    delete process.env[PILOT];
    expect(listStaffpassMcpTools()).toBe(STAFFPASS_MCP_TOOLS);
    expect(listStaffpassMcpTools({ orgId: ORG_A })).toBe(STAFFPASS_MCP_TOOLS);
    expect(listStaffpassMcpTools().some((t) => t.name === NOTICES_LIST_TOOL)).toBe(false);
  });

  test("flag ON + empty pilot → tools listed; pilot org only for that org", () => {
    expect(listStaffpassMcpTools().map((t) => t.name)).toContain(NOTICES_LIST_TOOL);
    expect(listStaffpassMcpTools().map((t) => t.name)).toContain(NOTICES_ACK_TOOL);
    process.env[PILOT] = ORG_A;
    expect(listStaffpassMcpTools({ orgId: ORG_A }).some((t) => t.name === NOTICES_LIST_TOOL)).toBe(true);
    expect(listStaffpassMcpTools({ orgId: ORG_B }).some((t) => t.name === NOTICES_LIST_TOOL)).toBe(false);
    expect(listStaffpassMcpTools()).toBe(STAFFPASS_MCP_TOOLS);
  });

  test("schemas are closed (no orgId/employeeId; additionalProperties false)", () => {
    const list = listStaffpassMcpTools().find((t) => t.name === NOTICES_LIST_TOOL)!;
    const ack = listStaffpassMcpTools().find((t) => t.name === NOTICES_ACK_TOOL)!;
    expect(list.inputSchema.additionalProperties).toBe(false);
    expect(ack.inputSchema.additionalProperties).toBe(false);
    expect(list.inputSchema.properties.orgId).toBeUndefined();
    expect(ack.inputSchema.properties.employeeId).toBeUndefined();
    expect(list.approvalClass).toBe("business");
    expect(ack.approvalClass).toBe("business");
  });
});

describe("staffpass_notices_list / ack", () => {
  test("list returns guardJa + contentTrust; never other audience members; records delivered", async () => {
    const n = __seedDemoNotice({
      title: "週次の仕様",
      changeSummary: "変更点",
      aiUsageChange: "list を毎日1回",
      audienceScope: "orgs",
      applyMode: "self_rules",
      targets: [{ orgId: ORG_A, employeeId: null }],
    });
    const r = await callStaffpassMcpTool(NOTICES_LIST_TOOL, { orgId: ORG_B, employeeId: EMP_B }, cred(ORG_A, EMP_A));
    expect(r.isError).toBe(false);
    const d = data(r);
    expect(d.ok).toBe(true);
    expect(d.source).toBe("staffpass_operator");
    expect(d.contentTrust).toBe("operator_information");
    expect(d.guardJa).toBe(OPERATOR_NOTICES_GUARD_JA);
    const notices = d.notices as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0].noticeId).toBe(n.id);
    expect(notices[0].audience).toBe("org");
    expect(notices[0].content).toEqual({ changeSummary: "変更点", aiUsageChange: "list を毎日1回" });
    expect(JSON.stringify(r)).not.toContain(ORG_B);
    expect(JSON.stringify(r)).not.toContain(EMP_B);
    expect((notices[0].yourState as Record<string, unknown>).state).toBe("delivered");
  });

  test("org B does not see org A's notice; the same id acks as not_found", async () => {
    const n = __seedDemoNotice({
      title: "A only",
      changeSummary: "secret-to-a",
      aiUsageChange: "do-not-leak",
      audienceScope: "orgs",
      targets: [{ orgId: ORG_A, employeeId: null }],
    });
    const listed = await callStaffpassMcpTool(NOTICES_LIST_TOOL, { noticeId: n.id }, cred(ORG_B, EMP_B));
    expect(listed.isError).toBe(true);
    expect(data(listed).code).toBe("not_found");
    expect(JSON.stringify(listed)).not.toContain("secret-to-a");
    expect(JSON.stringify(listed)).not.toContain("A only");

    const acked = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "read" },
      cred(ORG_B, EMP_B)
    );
    expect(acked.isError).toBe(true);
    expect(data(acked).code).toBe("not_found");
    expect(JSON.stringify(acked)).not.toContain("secret-to-a");
  });

  test("ack applied (self_rules) is self_reported; declined requires note; stale version is refused", async () => {
    const n = __seedDemoNotice({
      title: "apply me",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
      applyMode: "self_rules",
    });
    const noNote = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "declined" },
      cred(ORG_A, EMP_A)
    );
    expect(data(noNote).code).toBe("note_required");

    const stale = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 99, state: "read" },
      cred(ORG_A, EMP_A)
    );
    expect(data(stale).code).toBe("stale_version");

    const applied = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "applied" },
      cred(ORG_A, EMP_A)
    );
    expect(applied.isError).toBe(false);
    expect(data(applied).applyEvidence).toBe("self_reported");
    expect((data(applied).yourState as Record<string, unknown>).state).toBe("applied");

    const again = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "applied" },
      cred(ORG_A, EMP_A)
    );
    expect(data(again).ok).toBe(true);

    const unread = await callStaffpassMcpTool(NOTICES_LIST_TOOL, {}, cred(ORG_A, EMP_A));
    expect((data(unread).notices as unknown[]).length).toBe(0);
    expect(data(unread).unreadCount).toBe(0);
  });

  test("instructions_via_approval + applied without a verified ticket stays needs_tenant_approval (fail closed)", async () => {
    const n = __seedDemoNotice({
      title: "needs ticket",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
      applyMode: "instructions_via_approval",
    });
    const r = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "applied", configChangeApprovalId: "apr_missing" },
      cred(ORG_A, EMP_A)
    );
    expect(r.isError).toBe(false);
    expect((data(r).yourState as Record<string, unknown>).state).toBe("needs_tenant_approval");
  });

  test("ack note with a secret is blocked (surface operator_notice_ack); receipt stays unapplied", async () => {
    const n = __seedDemoNotice({
      title: "secret note",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
    });
    const secret = "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab";
    const r = await callStaffpassMcpTool(
      NOTICES_ACK_TOOL,
      { noticeId: n.id, version: 1, state: "declined", note: `理由: ${secret}` },
      cred(ORG_A, EMP_A)
    );
    expect(r.isError).toBe(true);
    expect(data(r).code).toBe("secret_detected_in_payload");
    expect(JSON.stringify(r)).not.toContain(secret.slice(8, 24));
    const listed = await callStaffpassMcpTool(NOTICES_LIST_TOOL, { noticeId: n.id }, cred(ORG_A, EMP_A));
    expect((data(listed).notices as Array<Record<string, unknown>>)[0].yourState).toMatchObject({ state: "delivered" });
  });

  test("flag OFF refuses the call and does not list tools", async () => {
    delete process.env[FLAG];
    const r = await callStaffpassMcpTool(NOTICES_LIST_TOOL, {}, cred(ORG_A, EMP_A));
    expect(r.isError).toBe(true);
    expect(data(r).code).toBe("feature_disabled");
  });
});

describe("whoami operatorNotices", () => {
  test("flag ON: counts only (no body); flag OFF: field omitted", async () => {
    __seedDemoNotice({
      title: "whoami body must not appear",
      changeSummary: "hidden-summary-xyz",
      aiUsageChange: "hidden-usage-xyz",
      audienceScope: "all",
      sticky: true,
      severity: "urgent",
    });
    const on = await callStaffpassMcpTool("staffpass_whoami", {}, cred(DEMO_ORG.id, "emp_sales"));
    const payload = data(on);
    const block = payload.operatorNotices as Record<string, unknown>;
    expect(block.unread).toBe(1);
    expect(block.urgentUnread).toBe(1);
    expect(block.pendingApply).toBe(1);
    expect(block.ruleJa).toBe(OPERATOR_NOTICES_WHOAMI_RULE_JA);
    expect(JSON.stringify(on)).not.toContain("hidden-summary-xyz");
    expect(JSON.stringify(on)).not.toContain("whoami body must not appear");

    delete process.env[FLAG];
    const off = await callStaffpassMcpTool("staffpass_whoami", {}, cred(DEMO_ORG.id, "emp_sales"));
    expect("operatorNotices" in data(off)).toBe(false);
  });
});

describe("Gateway does not read operator notices", () => {
  test("lib/gateway/invoke.ts does not import operator-notices", () => {
    const src = readFileSync(resolve("lib/gateway/invoke.ts"), "utf8");
    expect(src).not.toContain("operator-notices");
    expect(src).not.toContain("operatorNotices");
    expect(src).not.toContain("staffpass_notices");
  });
});
