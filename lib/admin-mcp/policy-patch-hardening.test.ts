/**
 * PR-C (木村 / 八坂 2026-10-05 09:34): admin MCP policy.patch hardening.
 *  1. keys policy.patch does not apply (allowedAccounts, postingAs, …) are
 *     refused with use_dedicated_tool + the tool to use (no ticket);
 *  2. toolApprovalDefaults is an explicit schema property;
 *  3. scopes are checked against ALL_SCOPES before a ticket exists;
 *  4. the approval card shows the before → after diff and the SoD verdict
 *     (no secrets);
 *  5. an agent-supplied SoD acknowledgement is ignored — the acknowledgement
 *     is the human approval of the card that showed the SoD verdict;
 *  6. the admin still cannot add permissions to its own badge (regression).
 * The org always comes from the credential. Demo mode, no network.
 */
import { describe, expect, test } from "bun:test";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { createApproval, getApprovalById, getEmployee, linkAgent, listApprovals, listAuditEvents, resolveApproval } from "@/lib/data";
import { issueEmployee } from "@/lib/data/employees";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import type { EmployeeScope } from "@/lib/types";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_policy_patch_other";
const BASE_SCOPES: EmployeeScope[] = ["tools:read", "approvals:request", "audit:append"];
/** comm_external + commit → SoD warn that needs an operator acknowledgement (unless always_human). */
const SOD_SCOPES: EmployeeScope[] = ["tools:read", "mail:send", "calendar:confirm", "approvals:request"];

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_policy_patch", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

let seq = 0;
async function hire(scopes: EmployeeScope[] = BASE_SCOPES) {
  seq += 1;
  const issued = await issueEmployee({
    orgId: ORG, displayName: `権限テスト ${seq}`, roleLabel: "事務", scopes, allowedPurposes: ["ops.admin"],
    approvalPolicy: "risk_based", spend: null, allowedAccounts: [], secretHash: `hash_pph_secret_${seq}`,
    secretPrefix: `gb_emp_pph${seq}`, expiresAt: null, auditSummary: "policy patch hardening test",
  });
  return issued.employee;
}
const data = (r: Awaited<ReturnType<typeof callAdminMcpTool>>) => r.structuredContent as Record<string, unknown>;
const ticketCount = async () => (await listApprovals(ORG)).filter((a) => a.tool === "policy.patch").length;
async function call(args: Record<string, unknown>) {
  const before = await ticketCount();
  const r = await callAdminMcpTool("policy.patch", args, demoCred());
  return { r, d: data(r), newTickets: (await ticketCount()) - before };
}
async function approveAndFulfil(approvalId: string) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_pph" });
  return fulfillApprovedAdmin(approved!);
}
/** A ticket exactly as an older build (or a tampered row) would have stored it. */
async function legacyTicket(adminMutation: Record<string, unknown>) {
  const created = await createApproval({
    orgId: ORG, employeeId: "", credentialId: "", title: "権限の更新", purpose: "admin.policy", summary: "legacy card",
    risk: "high", tool: "policy.patch", jobId: `job_pph_legacy_${++seq}`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS, approvalClass: ADMIN_AUDIT_CLASS, auditAction: "admin.policy", always_human: true,
      adminTool: "policy.patch", isAdminMcpTool: true, adminMutation,
      adminRequester: { kind: "admin_agent", grokBotAgentId: "grok_admin_policy_patch", actorId: "adm_pph" },
    },
  });
  return created.approval.id;
}

describe("1. keys policy.patch does not apply → use_dedicated_tool / unsupported_key (no ticket)", () => {
  test("allowedAccounts → employees.allowedAccounts.add / .remove", async () => {
    const e = await hire();
    const { r, d, newTickets } = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", allowedAccounts: [{ service: "slack", accountId: "U123" }] });
    expect(r.isError).toBe(true);
    expect(d).toMatchObject({ ok: false, code: "use_dedicated_tool", keys: ["allowedAccounts"] });
    expect(d.dedicatedTools).toEqual({ allowedAccounts: ["employees.allowedAccounts.add", "employees.allowedAccounts.remove"] });
    expect(d.dedicatedTool).toBe("employees.allowedAccounts.add");
    expect(newTickets).toBe(0);
  });
  test("postingAs → employees.postingIdentity.set; approvalChannelId → setup.lineApproval.setEmployeeInbox", async () => {
    const e = await hire();
    let res = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", postingAs: "user" });
    expect(res.d).toMatchObject({ code: "use_dedicated_tool", dedicatedTool: "employees.postingIdentity.set" });
    expect(res.newTickets).toBe(0);
    res = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", approvalChannelId: "nch_x", postingAs: "bot" });
    expect(res.d.code).toBe("use_dedicated_tool");
    expect(res.d.dedicatedTools).toEqual({ approvalChannelId: ["setup.lineApproval.setEmployeeInbox"], postingAs: ["employees.postingIdentity.set"] });
    expect(res.newTickets).toBe(0);
  });
  test("keys with no admin MCP tool (displayName, spend, …) and orgId → unsupported_key", async () => {
    const e = await hire();
    let res = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", displayName: "x", spend: { monthlyJpy: 1 } });
    expect(res.d).toMatchObject({ ok: false, code: "unsupported_key", keys: ["displayName", "spend"] });
    expect(res.newTickets).toBe(0);
    res = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", orgId: OTHER_ORG });
    expect(res.d).toMatchObject({ ok: false, code: "unsupported_key", keys: ["orgId"] });
    expect(String(res.d.message)).toContain("認証");
    expect(res.newTickets).toBe(0);
  });
});

describe("2. toolApprovalDefaults is an explicit schema property", () => {
  const tool = () => ADMIN_MCP_TOOLS.find((t) => t.name === "policy.patch")!;
  test("schema: closed (additionalProperties false), toolApprovalDefaults with per-tool enums, no allowedAccounts / postingAs", () => {
    const schema = tool().inputSchema as { properties: Record<string, Record<string, unknown>>; additionalProperties: unknown };
    expect(schema.additionalProperties).toBe(false);
    const tad = schema.properties.toolApprovalDefaults as { type: string; properties: Record<string, { enum: string[] }>; additionalProperties: unknown };
    expect(tad.type).toBe("object");
    expect(tad.additionalProperties).toBe(false);
    expect(tad.properties["mail.send"].enum.sort()).toEqual(["always_human", "auto", "deny", "risk_based"]);
    expect(tad.properties["slack.post"].enum.sort()).toEqual(["always_human", "deny"]);
    for (const k of ["allowedAccounts", "postingAs", "sodOverrideAcknowledged", "orgId"]) expect(k in schema.properties).toBe(false);
    expect(tool().description).toContain("use_dedicated_tool");
  });
  test("a valid toolApprovalDefaults is queued and applied after approval", async () => {
    const e = await hire();
    const { d } = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", toolApprovalDefaults: { "files.write": "deny" } });
    expect(d.code).toBe("needs_approval");
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f?.ok).toBe(true);
    expect((await getEmployee(e.id, ORG))?.toolApprovalDefaults?.["files.write"]).toBe("deny");
  });
  test("unknown tool key or a value the tool does not accept → invalid_tool_approval_defaults (no ticket)", async () => {
    const e = await hire();
    for (const tad of [{ "nope.tool": "auto" }, { "slack.post": "auto" }, { "mail.send": "yes" }, ["mail.send"]]) {
      const { d, newTickets } = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", toolApprovalDefaults: tad });
      expect([JSON.stringify(tad), d.code, newTickets]).toEqual([JSON.stringify(tad), "invalid_tool_approval_defaults", 0]);
    }
  });
});

describe("3. scopes are checked against ALL_SCOPES when the request comes in", () => {
  test("unknown / non-string / empty scopes → refused before any ticket", async () => {
    const e = await hire();
    let res = await call({ employeeId: e.id, scopes: ["tools:read", "admin:all"], approvalPolicy: "risk_based" });
    expect(res.d).toMatchObject({ ok: false, code: "unknown_scopes", unknownScopes: ["admin:all"] });
    expect(res.newTickets).toBe(0);
    res = await call({ employeeId: e.id, scopes: ["tools:read", 7], approvalPolicy: "risk_based" });
    expect(res.d.code).toBe("unknown_scopes");
    res = await call({ employeeId: e.id, scopes: [], approvalPolicy: "risk_based" });
    expect(res.d.code).toBe("scopes_required");
    res = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "yolo" });
    expect(res.d.code).toBe("invalid_approval_policy");
    expect(res.newTickets).toBe(0);
    expect(ALL_SCOPES.includes("admin:all" as EmployeeScope)).toBe(false);
  });
  test("a stored ticket with an unknown scope is refused at fulfil (no silent filtering, nothing written)", async () => {
    const e = await hire();
    const id = await legacyTicket({ employeeId: e.id, scopes: ["tools:read", "admin:all"], approvalPolicy: "always_human" });
    const f = await approveAndFulfil(id);
    expect(f).toMatchObject({ ok: false, error: "unknown_scopes" });
    expect((await getEmployee(e.id, ORG))?.approvalPolicy).toBe("risk_based");
  });
});

describe("4. approval card: diff + SoD verdict, no secrets", () => {
  test("the card shows added / removed scopes, the policy change and the SoD verdict", async () => {
    const e = await hire();
    const { d } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "risk_based", allowedPurposes: ["ops.admin", "sales.followup"] });
    expect(d.code).toBe("needs_approval");
    const summary = String((await getApprovalById(String(d.approvalId), ORG))?.summary);
    expect(summary).toContain(e.displayName);
    expect(summary).toContain("追加: mail:send（メールを送る）");
    expect(summary).toContain("calendar:confirm");
    expect(summary).toContain("削除: audit:append");
    expect(summary).toContain("承認方針: 変更なし（risk_based）");
    expect(summary).toContain("sales.followup");
    expect(summary).toContain("職務分離(SoD): 警告");
    expect(summary).toContain("社外送信");
    expect(summary).toContain("日程確定");
    expect(summary).toContain("承認すると、この職務分離の警告を確認したものとして扱います");
    expect(summary).not.toMatch(/gb_emp_|hash_pph|secret/i);
    expect(String(d.summary)).toBe(summary);
  });
  test("no SoD issue / always_human → the card says no acknowledgement is needed", async () => {
    const e = await hire();
    let { d } = await call({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "always_human" });
    let summary = String((await getApprovalById(String(d.approvalId), ORG))?.summary);
    expect(summary).toContain("承認方針: risk_based → always_human");
    expect(summary).toContain("職務分離(SoD): 問題なし");
    ({ d } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "always_human" }));
    summary = String((await getApprovalById(String(d.approvalId), ORG))?.summary);
    expect(summary).toContain("職務分離(SoD): 警告");
    expect(summary).not.toContain("確認したものとして扱います");
  });
});

describe("5. SoD acknowledgement = the human approval of the card (agent flag ignored)", () => {
  test("agent-set sodOverrideAcknowledged is not queued and is reported as ignored", async () => {
    const e = await hire();
    const { d } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "risk_based", sodOverrideAcknowledged: true });
    expect(d.code).toBe("needs_approval");
    expect(d.ignoredKeys).toEqual(["sodOverrideAcknowledged"]);
    const mutation = (await getApprovalById(String(d.approvalId), ORG))?.metadata?.adminMutation as Record<string, unknown>;
    expect("sodOverrideAcknowledged" in mutation).toBe(false);
    expect(mutation.policyPatchCard).toMatchObject({ sodLevel: "warn", sodNeedsAck: true });
  });
  test("approving the card that showed the warning applies it; audit records the approver-card acknowledgement", async () => {
    const e = await hire();
    const { d } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "risk_based" });
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f?.ok).toBe(true);
    const after = await getEmployee(e.id, ORG);
    expect([...(after?.scopes ?? [])].sort()).toEqual([...SOD_SCOPES].sort());
    const audit = (await listAuditEvents(ORG, 500)).find((a) => a.action === "admin.policy" && a.employeeId === e.id && a.metadata?.approvalId === d.approvalId);
    expect(audit?.metadata).toMatchObject({ sodLevel: "warn", sodAckSource: "approver_card" });
  });
  test("a ticket whose card did not show the SoD verdict (older build / agent ack only) is refused, nothing written", async () => {
    const e = await hire();
    const id = await legacyTicket({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "risk_based", sodOverrideAcknowledged: true });
    const f = await approveAndFulfil(id);
    expect(f).toMatchObject({ ok: false, error: "sod_not_shown_on_card" });
    expect([...((await getEmployee(e.id, ORG))?.scopes ?? [])].sort()).toEqual([...BASE_SCOPES].sort());
  });
  test("the SoD verdict changed since the card (card said ok) → refused, nothing written", async () => {
    const e = await hire();
    const id = await legacyTicket({
      employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "risk_based",
      policyPatchCard: { version: 1, sodLevel: "ok", sodDomains: [], sodNeedsAck: false },
    });
    const f = await approveAndFulfil(id);
    expect(f).toMatchObject({ ok: false, error: "sod_changed_since_card" });
    expect([...((await getEmployee(e.id, ORG))?.scopes ?? [])].sort()).toEqual([...BASE_SCOPES].sort());
  });
  test("no acknowledgement needed (always_human / no warning) → legacy tickets still work", async () => {
    const e = await hire();
    const id = await legacyTicket({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "always_human" });
    expect((await approveAndFulfil(id))?.ok).toBe(true);
    expect((await getEmployee(e.id, ORG))?.approvalPolicy).toBe("always_human");
  });
});

describe("6. org from the credential; the admin cannot grant its own badge (regression)", () => {
  test("employee bound to the calling admin agent → cannot_grant_self_scopes, no ticket", async () => {
    const e = await hire();
    await linkAgent(e.id, { orgId: ORG, grokBotAgentId: "grok_admin_policy_patch" });
    const { r, d, newTickets } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "auto" });
    expect(r.isError).toBe(true);
    expect(d.code).toBe("cannot_grant_self_scopes");
    expect(newTickets).toBe(0);
  });
  test("bound to the requesting admin agent after the ticket was queued → refused at fulfil, nothing written", async () => {
    const e = await hire();
    const { d } = await call({ employeeId: e.id, scopes: SOD_SCOPES, approvalPolicy: "always_human" });
    expect(d.code).toBe("needs_approval");
    await linkAgent(e.id, { orgId: ORG, grokBotAgentId: "grok_admin_policy_patch" });
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f).toMatchObject({ ok: false, error: "cannot_grant_self_scopes" });
    expect((await getEmployee(e.id, ORG))?.approvalPolicy).toBe("risk_based");
  });
  test("an employee of another org is not found (no orgId argument is accepted)", async () => {
    // Demo issueEmployee always uses the demo org; move the row to another org.
    const other = await hire();
    getRuntimeEmployees().find((x) => x.id === other.id)!.orgId = OTHER_ORG;
    const { d, newTickets } = await call({ employeeId: other.id, scopes: BASE_SCOPES, approvalPolicy: "always_human" });
    expect(d.code).toBe("employee_not_found");
    expect(newTickets).toBe(0);
    expect((await getEmployee(other.id, OTHER_ORG))?.approvalPolicy).toBe("risk_based");
  });
});
