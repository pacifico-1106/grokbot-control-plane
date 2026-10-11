/**
 * 木村 2026-10-10 01:29: #275 (policy.patch hardening) × main 734149a
 * (#279 approver authority F2 fingerprint + #307 CAS). With
 * APPROVER_AUTHORITY_ENABLED on, a ticket filed through the real intake must
 * carry BOTH the card record (#275: base + SoD verdict) and the F2 context
 * fingerprint, and fulfil runs, in order:
 *   parse(fromTicket) → requesting-admin binding → card shown → employee+org
 *   → stale (card base) → SoD (card ack) → CAS guard (F2 fingerprint + pin).
 * - The server-built card key is not an "unknown policy key" for the
 *   approver classification (it would make every policy.patch owner-only).
 * - Not stale + nothing changed in the CAS window → written; omitted
 *   allowedPurposes / actionLimits are passed explicitly (pinned values).
 * - Changed after filing → policy_patch_stale (before the CAS), nothing written.
 * - Changed inside the CAS window → approver_context_changed, nothing written.
 * - actionLimits null is refused (intake and stored ticket); {} clears.
 * Demo mode, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { EmployeeScope } from "@/lib/types";

// A one-shot hook inside updateEmployeePolicy's only await before the write
// (the org SoD policy read) = "someone saved at that very moment" — i.e.
// after the CAS guard pinned its snapshot. fulfillPolicy's own SoD-gate read
// of the same function must NOT trigger it (that is before the guard).
let casWindowChange: (() => void) | null = null;
const realOrgContext = { ...(await import("@/lib/data/org-context")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data/org-context", {
  getOrgSodWarnPolicy: (orgId?: string | null) => {
    if (casWindowChange && (new Error().stack ?? "").includes("updateEmployeePolicy")) {
      const hook = casWindowChange;
      casWindowChange = null;
      hook();
    }
    return realOrgContext.getOrgSodWarnPolicy(orgId);
  },
});

const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { POLICY_PATCH_CARD_KEY } = await import("@/lib/admin-mcp/policy-patch-guard");
const { createApproval, getApprovalById, listApprovals, listAuditEvents } = await import("@/lib/data");
const { getEmployee, issueEmployee } = await import("@/lib/data/employees");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { DEMO_ORG, getRuntimeEmployees, resetRuntimeMembers } = await import("@/lib/demo-data");
const { ADMIN_MCP_TOOLS, callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { classifyApproverRequirement } = await import("@/lib/approver-authority/targets");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
const BASE_SCOPES: EmployeeScope[] = ["tools:read", "approvals:request", "audit:append"];
const LIMITS = { "slack.post": { perDay: 5 } };
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = "true";
  casWindowChange = null;
  resetRuntimeMembers();
});
afterEach(() => {
  casWindowChange = null;
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
});

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_cas_merge", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}
let seq = 0;
async function hire() {
  seq += 1;
  const issued = await issueEmployee({
    orgId: ORG, displayName: `CAS統合 ${seq}`, roleLabel: "事務", scopes: BASE_SCOPES, allowedPurposes: ["ops.admin"],
    approvalPolicy: "risk_based", spend: null, allowedAccounts: [], secretHash: `hash_pcm_${seq}`,
    secretPrefix: `gb_emp_pcm${seq}`, expiresAt: null, auditSummary: "policy.patch × CAS merge test",
  });
  const live = getRuntimeEmployees().find((e) => e.id === issued.employee.id)!;
  live.actionLimits = structuredClone(LIMITS) as never;
  return issued.employee;
}
const live = (id: string) => getRuntimeEmployees().find((e) => e.id === id)!;
const ticketCount = async () => (await listApprovals(ORG)).filter((a) => a.tool === "policy.patch").length;
async function file(args: Record<string, unknown>) {
  const before = await ticketCount();
  const r = await callAdminMcpTool("policy.patch", args, demoCred());
  const d = r.structuredContent as Record<string, unknown>;
  return { r, d, newTickets: (await ticketCount()) - before };
}
async function approveAndFulfil(approvalId: string) {
  const r = await resolveApprovalWithWorkflow(approvalId, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
  expect(r.ok).toBe(true);
  return fulfillApprovedAdmin((await getApprovalById(approvalId, ORG))!);
}
/** The audit of an applied write (not the "承認待ち" filing audit). */
const policyAudits = async (approvalId: string) =>
  (await listAuditEvents(ORG)).filter((e) => {
    const m = e.metadata as Record<string, unknown> | undefined;
    return e.action === "admin.policy" && m?.approvalId === approvalId && m?.sodAckSource !== undefined;
  });

describe("intake (flag ON): card record + F2 fingerprint on the same ticket", () => {
  test("the ticket carries policyPatchCard and the context fingerprint; the card key is not an unknown policy key (standard approver)", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    expect(d.code).toBe("needs_approval");
    const t = (await getApprovalById(String(d.approvalId), ORG))!;
    const mutation = t.metadata?.adminMutation as Record<string, unknown>;
    expect(mutation[POLICY_PATCH_CARD_KEY]).toMatchObject({ version: 2, fitsAllSurfaces: true });
    expect(typeof t.approverAuthority?.contextFingerprint).toBe("string");
    expect(t.approverAuthority?.reasons).not.toContain("unknown_policy_key");
    expect(t.requiredApproverKind).toBe("owner_or_designated_admin");
  });
  test("an agent cannot supply the card key itself → unsupported_key, no ticket", async () => {
    const e = await hire();
    const { d, newTickets } = await file({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", [POLICY_PATCH_CARD_KEY]: { version: 2 } });
    expect(d).toMatchObject({ ok: false, code: "unsupported_key", keys: [POLICY_PATCH_CARD_KEY] });
    expect(newTickets).toBe(0);
  });
  test("classifier: the card key alone adds nothing; any other unknown key still → owner", () => {
    const ctx = { currentEmployeeScopes: BASE_SCOPES, currentEmployeeApprovalPolicy: "risk_based", currentEmployeeActionLimits: {}, currentEmployeeToolApprovalDefaults: {} };
    const args = { employeeId: "e", scopes: BASE_SCOPES, approvalPolicy: "risk_based" };
    const classify = (extra: Record<string, unknown>) =>
      classifyApproverRequirement({ tool: "policy.patch", metadata: { adminMutation: { ...args, ...extra } }, context: ctx as never });
    expect(classify({ [POLICY_PATCH_CARD_KEY]: { version: 2 } })?.kind).toBe("owner_or_designated_admin");
    expect(classify({ somethingElse: 1 })?.reasons).toContain("unknown_policy_key");
  });
});

describe("fulfil (flag ON): not stale + CAS passes → written", () => {
  test("omitted allowedPurposes / actionLimits are kept (passed explicitly, the pinned values); audit records the card ack source", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f).toMatchObject({ ok: true, tool: "policy.patch" });
    const after = (await getEmployee(e.id, ORG))!;
    expect(after.scopes).toContain("slack:post");
    expect(after.allowedPurposes).toEqual(["ops.admin"]);
    expect(after.actionLimits).toEqual(LIMITS as never);
    const audits = await policyAudits(String(d.approvalId));
    expect(audits.length).toBe(1);
    expect(audits[0].metadata).toMatchObject({ sodAckSource: "not_required" });
  });
  test("explicit {} actionLimits clears every cap (the only way to clear)", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", actionLimits: {} });
    expect(d.code).toBe("needs_approval");
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f?.ok).toBe(true);
    expect((await getEmployee(e.id, ORG))!.actionLimits).toEqual({});
  });
});

describe("fulfil (flag ON): changed after filing → refused before any write", () => {
  // allowedPurposes is not in the F2 fingerprint: the F2 pre-fulfil check
  // passes, and fulfillPolicy's stale gate (step 5, before the CAS) refuses.
  test("allowedPurposes changed → policy_patch_stale (card base), nothing written, no applied audit", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    live(e.id).allowedPurposes = ["ops.other"];
    const snapshot = structuredClone(live(e.id));
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f).toMatchObject({ ok: false, error: "policy_patch_stale" });
    expect(String((f as { nextStepJa?: string }).nextStepJa)).toContain("用途（allowedPurposes）");
    expect(structuredClone(live(e.id))).toEqual(snapshot);
    expect((await policyAudits(String(d.approvalId))).length).toBe(0);
  });
  // actionLimits is in BOTH the card base and the F2 fingerprint: the F2
  // pre-fulfil check (verify.ts) refuses first with approver_context_changed.
  test("actionLimits changed → approver_context_changed (F2 pre-check), nothing written, no applied audit", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    live(e.id).actionLimits = { "slack.post": { perDay: 9 } } as never;
    const snapshot = structuredClone(live(e.id));
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f).toMatchObject({ ok: false, error: "approver_context_changed" });
    expect(structuredClone(live(e.id))).toEqual(snapshot);
    expect((await policyAudits(String(d.approvalId))).length).toBe(0);
  });
  test("flag OFF: the same actionLimits change → policy_patch_stale (#275 alone still protects)", async () => {
    process.env[FLAG] = "false";
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    live(e.id).actionLimits = { "slack.post": { perDay: 9 } } as never;
    const snapshot = structuredClone(live(e.id));
    const f = await approveAndFulfil(String(d.approvalId));
    expect(f).toMatchObject({ ok: false, error: "policy_patch_stale" });
    expect(structuredClone(live(e.id))).toEqual(snapshot);
  });
});

describe("fulfil (flag ON): changed inside the CAS window → approver_context_changed", () => {
  for (const [label, change] of [
    ["actionLimits", (id: string) => { live(id).actionLimits = { "slack.post": { perDay: 77 } } as never; }],
    ["allowedPurposes", (id: string) => { live(id).allowedPurposes = ["ops.window"]; }],
  ] as const) {
    test(`${label} changed between the guard pin and the write → refused, the concurrent value survives`, async () => {
      const e = await hire();
      const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
      casWindowChange = () => change(e.id);
      const f = await approveAndFulfil(String(d.approvalId));
      expect(casWindowChange).toBeNull(); // the window was really hit
      expect(f).toMatchObject({ ok: false, error: "approver_context_changed" });
      const after = live(e.id);
      expect(after.scopes).not.toContain("slack:post");
      if (label === "actionLimits") expect(after.actionLimits).toEqual({ "slack.post": { perDay: 77 } } as never);
      else expect(after.allowedPurposes).toEqual(["ops.window"]);
      expect((await policyAudits(String(d.approvalId))).length).toBe(0);
    });
  }
});

describe("fulfil order: earlier gates win", () => {
  test("card cut AND stale → card_truncated (card gate runs before the stale check)", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
    const t = (await getApprovalById(String(d.approvalId), ORG))!;
    const mutation = { ...(t.metadata?.adminMutation as Record<string, unknown>) };
    const id = await (async () => {
      const created = await createApproval({
        orgId: ORG, employeeId: "", credentialId: "", title: "権限の更新", purpose: "admin.policy", summary: "x".repeat(1200),
        risk: "high", tool: "policy.patch", jobId: `job_pcm_cut_${++seq}`,
        metadata: { ...(t.metadata ?? {}), adminMutation: mutation },
        approverAuthority: t.approverAuthority ?? undefined,
        requiredApproverKind: t.requiredApproverKind ?? undefined,
      } as never);
      return created.approval.id;
    })();
    live(e.id).allowedPurposes = ["ops.other"];
    const f = await approveAndFulfil(id);
    expect(f).toMatchObject({ ok: false, error: "card_truncated" });
  });
  test("employee moved to another org after approval: flag ON → refused (F2 pre-check: unreadable); flag OFF → employee_not_found (step 4 org match)", async () => {
    for (const flag of ["true", "false"] as const) {
      process.env[FLAG] = flag;
      const e = await hire();
      const { d } = await file({ employeeId: e.id, scopes: [...BASE_SCOPES, "slack:post"], approvalPolicy: "risk_based" });
      const r = await resolveApprovalWithWorkflow(String(d.approvalId), "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
      expect(r.ok).toBe(true);
      const approved = (await getApprovalById(String(d.approvalId), ORG))!;
      live(e.id).orgId = "org_pcm_other";
      try {
        const out = await fulfillApprovedAdmin(approved).then((v) => ({ v }), (err: Error) => ({ err: err.message }));
        if (flag === "true") expect(out).toMatchObject({ v: { ok: false, error: "approver_context_changed" } });
        else expect(out).toMatchObject({ v: { ok: false, error: "employee_not_found" } });
        expect(live(e.id).scopes).not.toContain("slack:post");
      } finally {
        live(e.id).orgId = ORG;
      }
    }
  });
});

describe("actionLimits null is refused (only an explicit {} clears)", () => {
  test("tool description / schema: one merged description; {} clears, null is refused; PROMOTE_OWNER-era money note kept", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "policy.patch")!;
    expect(tool.description).toContain("only an explicit {} removes every cap");
    expect(tool.description).toContain("null is refused (invalid_action_limits)");
    expect(tool.description).not.toContain("{} or null");
    expect(tool.description).toContain("use_dedicated_tool");
    expect(tool.description).toContain("APPROVER_AUTHORITY_ENABLED");
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }>; additionalProperties: unknown };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.actionLimits.description).toContain("null is refused");
  });
  test("intake: null → invalid_action_limits, no ticket; the message says to use {}", async () => {
    const e = await hire();
    const { r, d, newTickets } = await file({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based", actionLimits: null });
    expect(r.isError).toBe(true);
    expect(d).toMatchObject({ ok: false, code: "invalid_action_limits" });
    expect(String(d.message)).toContain("{}");
    expect(newTickets).toBe(0);
  });
  test("stored ticket with actionLimits null → invalid_action_limits at fulfil, nothing written", async () => {
    const e = await hire();
    const { d } = await file({ employeeId: e.id, scopes: BASE_SCOPES, approvalPolicy: "risk_based" });
    const t = (await getApprovalById(String(d.approvalId), ORG))!;
    const snapshot = structuredClone(live(e.id));
    const r = await resolveApprovalWithWorkflow(t.id, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
    expect(r.ok).toBe(true);
    const approved = (await getApprovalById(t.id, ORG))!;
    (approved.metadata!.adminMutation as Record<string, unknown>).actionLimits = null;
    const f = await fulfillApprovedAdmin(approved);
    expect(f).toMatchObject({ ok: false, error: "invalid_action_limits" });
    expect(structuredClone(live(e.id))).toEqual(snapshot);
  });
});
