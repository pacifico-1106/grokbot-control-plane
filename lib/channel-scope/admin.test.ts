import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool, ADMIN_MCP_TOOLS } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { queueAdminToolForRequester } from "@/lib/admin-mcp/queue";
import { auditActionForAdminTool, isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { getToolApprovalKind } from "@/lib/approval-kind-routes/tool-kind-map";
import { isAdminToolAvailableForPlan, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getApprovalById, listAuditEvents, listEmployees, resolveApproval } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { SELF_APPROVAL_DENIED } from "@/lib/admin-mcp/self-approval";
import {
  __resetChannelScopeDemoStore,
  __setDemoRawPolicies,
  getEffectiveChannelScope,
  getEmployeeChannelScopeOverrideRaw,
  getOrgChannelScopePolicyRaw,
  setOrgChannelScopePolicy,
  upsertEmployeeChannelMembership,
} from "./data";
import {
  buildChannelScopeQueuedArgs,
  channelScopeStateHash,
  channelScopeWidens,
  CHANNEL_SCOPE_SNAPSHOT_KEY,
  prepareChannelScopePatch,
} from "./admin";
import { defaultChannelScopePolicy } from "./validate";
import { upsertOrgChannel } from "@/lib/data/directory";

const ORG = DEMO_ORG.id;
const saved = { a: process.env.P1_CHANNEL_SCOPE_ENABLED, b: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED };

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
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

type Data = Record<string, unknown>;
const call = async (name: string, args: Record<string, unknown>) =>
  (await callAdminMcpTool(name, args, demoCred())).structuredContent as Data;

async function approveAndFulfill(approvalId: string) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_owner" });
  expect(approved?.status).toBe("approved");
  return fulfillApprovedAdmin(approved!);
}

async function firstEmployeeId(): Promise<string> {
  const [employee] = await listEmployees(ORG);
  expect(employee).toBeTruthy();
  return employee.id;
}

beforeEach(() => {
  __resetChannelScopeDemoStore();
  delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
});
afterEach(() => {
  if (saved.a === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED; else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.a;
  if (saved.b === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED; else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = saved.b;
});

describe("registration", () => {
  test("tools are registered with the right classes", () => {
    for (const n of ["channelScope.get", "channelScope.patch", "channelScope.listMemberships"]) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(n)).toBe(true);
    }
    const byName = new Map(ADMIN_MCP_TOOLS.map((t) => [t.name, t]));
    expect(byName.get("channelScope.get")?.description).toContain("read-only");
    expect(byName.get("channelScope.listMemberships")?.description).toContain("read-only");
    expect(byName.get("channelScope.patch")?.description).toContain("always_human");
    expect(byName.get("channelScope.get")?.approvalClass).toBeUndefined();
    expect(byName.get("channelScope.listMemberships")?.approvalClass).toBeUndefined();
    expect(byName.get("channelScope.patch")?.approvalClass).toBe("admin");
  });

  test("approval kind = account; audit action admin.policy; plan scopes", () => {
    expect(getToolApprovalKind("channelScope.patch")).toBe("account");
    expect(getToolApprovalKind("channelScope.reconcile")).toBe("account");
    expect(getToolApprovalKind("channelScope.anythingNew")).toBe("account");
    expect(auditActionForAdminTool("channelScope.patch")).toBe("admin.policy");
    expect(READ_ONLY_ADMIN_TOOLS).toContain("channelScope.get");
    expect(isAdminToolAvailableForPlan("channelScope.get", "intern")).toBe(true);
    expect(isAdminToolAvailableForPlan("channelScope.listMemberships", "intern")).toBe(true);
    expect(isAdminToolAvailableForPlan("channelScope.patch", "intern")).toBe(false);
    expect(isAdminToolAvailableForPlan("channelScope.patch", "proper")).toBe(true);
  });
});

describe("flags OFF (default)", () => {
  test("get reports disabled + registered_only without reading stored policies", async () => {
    __setDemoRawPolicies(ORG, { org: { mode: "all_joined" } });
    const data = await call("channelScope.get", {});
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(false);
    expect((data.effective as Data).policy).toMatchObject({ mode: "registered_only" });
    expect(data.orgPolicy).toBeNull();
    expect(data.beforeStateHash).toBeNull();
  });

  test("patch is feature_disabled and files no ticket", async () => {
    const data = await call("channelScope.patch", { mode: "all_joined" });
    expect(data.code).toBe("feature_disabled");
    expect(data.approvalId).toBeUndefined();
  });

  test("listMemberships is disabled", async () => {
    const data = await call("channelScope.listMemberships", {});
    expect(data).toMatchObject({ ok: true, enabled: false, count: 0 });
  });
});

describe("flag ON", () => {
  beforeEach(() => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  });

  test("tenant default: queue (no write) → owner approve → applied + audit", async () => {
    const get0 = await call("channelScope.get", {});
    const hash0 = String(get0.beforeStateHash);
    const queued = await call("channelScope.patch", { mode: "all_joined", beforeStateHash: hash0 });
    expect(queued).toMatchObject({ needs_approval: true, always_human: true, auditClass: "admin", auditAction: "admin.policy", tool: "channelScope.patch" });
    expect((queued.diffSummary as string[]).join("\n")).toContain("未設定（継承） → 参加中すべて（社内のみ）");
    expect(String(queued.summary)).toContain("■ 変更内容");
    // Not applied before approval
    expect(await getOrgChannelScopePolicyRaw(ORG)).toBeNull();

    const approval = await getApprovalById(String(queued.approvalId), ORG);
    expect(approval && isAdminClassApproval(approval)).toBe(true);
    expect(approval?.metadata?.adminTool).toBe("channelScope.patch");
    const snap = (approval?.metadata?.adminMutation as Data)[CHANNEL_SCOPE_SNAPSHOT_KEY] as Data;
    expect(snap).toMatchObject({ layer: "org", employeeId: null, beforeStateHash: hash0, source: "admin_mcp", widens: true });

    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    const stored = (await getOrgChannelScopePolicyRaw(ORG)) as Data;
    expect(stored).toMatchObject({ mode: "all_joined", includeSlackConnect: false, updatedBy: `approval:${queued.approvalId}` });
    expect((await getEffectiveChannelScope(ORG)).source).toBe("org");
    const audits = await listAuditEvents(ORG, 50);
    const audit = audits.find((e) => e.action === "channel_scope.patch");
    expect(audit?.metadata).toMatchObject({ approvalId: queued.approvalId, layer: "org", approvedBy: "owner@example.com", widens: true });

    // The hash changed, so the old hash is now stale.
    const stale = await call("channelScope.patch", { mode: "registered_only", beforeStateHash: hash0 });
    expect(stale.code).toBe("before_state_mismatch");
  });

  test("admin agent cannot approve its own ticket", async () => {
    const queued = await call("channelScope.patch", { mode: "all_joined" });
    const cred = demoCred();
    let code = "";
    try {
      await resolveApproval(String(queued.approvalId), "approved", "agent", ORG, { actorId: cred.actorId, grokBotAgentId: cred.grokBotAgentId });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as Error).message;
    }
    expect(code).toBe(SELF_APPROVAL_DENIED);
    expect(await getOrgChannelScopePolicyRaw(ORG)).toBeNull();
  });

  test("before-state changed between filing and approval ⇒ before_state_mismatch, nothing written", async () => {
    const queued = await call("channelScope.patch", { mode: "all_joined" });
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), updatedBy: "someone-else" });
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment).toMatchObject({ ok: false, error: "before_state_mismatch" });
    expect((await getOrgChannelScopePolicyRaw(ORG)) as Data).toMatchObject({ mode: "registered_only", updatedBy: "someone-else" });
    const audits = await listAuditEvents(ORG, 50);
    expect(audits.some((e) => e.action === "channel_scope.patch_conflict")).toBe(true);
  });

  test("per-employee override and clearOverride", async () => {
    const employeeId = await firstEmployeeId();
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), mode: "all_joined" });
    const q1 = await call("channelScope.patch", { employeeId, mode: "registered_only" });
    expect(q1.needs_approval).toBe(true);
    expect((q1.diffSummary as string[])[0]).toContain("AI社員ごとの上書き");
    expect((await approveAndFulfill(String(q1.approvalId)))?.ok).toBe(true);
    expect(await getEffectiveChannelScope(ORG, employeeId)).toMatchObject({ source: "employee", policy: { mode: "registered_only" } });

    const get = await call("channelScope.get", { employeeId });
    expect(get.employeeOverride).toMatchObject({ mode: "registered_only" });
    const q2 = await call("channelScope.patch", { employeeId, clearOverride: true, beforeStateHash: get.beforeStateHash });
    expect((q2.diffSummary as string[]).join("\n")).toContain("上書きを解除");
    expect((await approveAndFulfill(String(q2.approvalId)))?.ok).toBe(true);
    expect(await getEmployeeChannelScopeOverrideRaw(ORG, employeeId)).toBeNull();
    expect((await getEffectiveChannelScope(ORG, employeeId)).source).toBe("org");
  });

  test("Slack Connect requires P1_CHANNEL_SCOPE_CONNECT_ENABLED at filing and at fulfill", async () => {
    const off = await call("channelScope.patch", { mode: "all_joined", includeSlackConnect: true });
    expect(off.code).toBe("connect_disabled");
    process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "1";
    const queued = await call("channelScope.patch", {
      mode: "all_joined",
      includeSlackConnect: true,
      connect: { allowedExternalTeamIds: ["t0peer"] },
    });
    expect(queued.needs_approval).toBe(true);
    const diff = (queued.diffSummary as string[]).join("\n");
    expect(diff).toContain("参加中すべて＋Slack Connect");
    expect(diff).toContain("T0PEER");
    expect(diff).toContain("⚠ 範囲が広がります");
    delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED; // kill switch flipped before approval
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment).toMatchObject({ ok: false, error: "connect_disabled" });
    expect(await getOrgChannelScopePolicyRaw(ORG)).toBeNull();
  });

  test("fulfill is refused when the master flag is turned OFF before approval", async () => {
    const queued = await call("channelScope.patch", { mode: "all_joined" });
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment).toMatchObject({ ok: false, error: "feature_disabled" });
  });

  test("input validation", async () => {
    const cases: [Data, string][] = [
      [{}, "validation_failed"],
      [{ mode: "everything" }, "validation_failed"],
      [{ mode: "registered_only", includeSlackConnect: true }, "validation_failed"],
      [{ mode: "all_joined", connect: { allowedExternalTeamIds: ["nope"] } }, "validation_failed"],
      [{ clearOverride: true }, "employee_required"],
      [{ employeeId: "emp_does_not_exist", mode: "all_joined" }, "employee_not_found"],
      [{ employeeId: "bad id!", mode: "all_joined" }, "invalid_employee_id"],
      [{ mode: "registered_only" }, "validation_failed"],
    ];
    // Unknown field is rejected by the MCP schema layer or by prepare.
    const unknownField = await prepareChannelScopePatch(ORG, { mode: "all_joined", surfaces: ["slack"] }, "admin_mcp");
    expect(unknownField.ok).toBe(false);
    for (const [args, code] of cases.slice(0, 7)) {
      const data = await call("channelScope.patch", args);
      expect({ args, code: data.code }).toEqual({ args, code });
    }
    // registered_only on an unset tenant default is a real change (pins the default) → accepted.
    expect((await call("channelScope.patch", { mode: "registered_only" })).needs_approval).toBe(true);
  });

  test("no_change when the stored policy already matches", async () => {
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), mode: "all_joined" });
    expect((await call("channelScope.patch", { mode: "all_joined" })).code).toBe("no_change");
    const employeeId = await firstEmployeeId();
    expect((await call("channelScope.patch", { employeeId, clearOverride: true })).code).toBe("no_change");
  });

  test("tampered snapshot on the ticket fails closed", async () => {
    const queued = await queueAdminToolForRequester({
      orgId: ORG,
      requester: { kind: "admin_agent", grokBotAgentId: null, actorId: "mem_filer" },
      tool: "channelScope.patch",
      args: { [CHANNEL_SCOPE_SNAPSHOT_KEY]: { layer: "org", employeeId: null, after: { mode: "all_joined", includeSlackConnect: true } } },
      summary: "tampered",
    });
    expect(queued.code).toBe("needs_approval");
    const fulfillment = await approveAndFulfill(String((queued as Data).approvalId));
    expect(fulfillment).toMatchObject({ ok: false, error: "missing_snapshot" });
  });

  test("web-style requester cannot self-approve", async () => {
    const prepared = await prepareChannelScopePatch(ORG, { mode: "all_joined" }, "web_api");
    if (!prepared.ok) throw new Error(prepared.code);
    const queued = await queueAdminToolForRequester({
      orgId: ORG,
      requester: { kind: "admin_agent", grokBotAgentId: null, actorId: "mem_web_admin" },
      tool: "channelScope.patch",
      args: buildChannelScopeQueuedArgs({}, prepared.snapshot),
      summary: prepared.summary,
    });
    let code = "";
    try {
      await resolveApproval(String((queued as Data).approvalId), "approved", "admin@example.com", ORG, { actorId: "mem_web_admin" });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe(SELF_APPROVAL_DENIED);
  });

  test("get returns hash, counts and unconfirmed Connect; listMemberships filters", async () => {
    const employeeId = await firstEmployeeId();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0LSTINT", classification: "internal", skipInspect: true });
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: "C0LSTINT", via: "user", state: "member" });
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: "C0LSTEXT", via: "bot", state: "out_of_scope" });
    const get = await call("channelScope.get", { employeeId });
    expect(get.enabled).toBe(true);
    expect(get.beforeStateHash).toBe(channelScopeStateHash("employee", employeeId, null));
    expect(get.memberships).toMatchObject({ member: 1, out_of_scope: 1, left: 0, removed: 0 });
    expect(Array.isArray(get.unconfirmedConnect)).toBe(true);

    const all = await call("channelScope.listMemberships", { employeeId });
    expect(all.count).toBe(2);
    const internal = await call("channelScope.listMemberships", { employeeId, classification: "internal" });
    expect((internal.memberships as Data[]).map((m) => m.externalId)).toEqual(["C0LSTINT"]);
    const oos = await call("channelScope.listMemberships", { state: "out_of_scope" });
    expect((oos.memberships as Data[]).map((m) => m.externalId)).toEqual(["C0LSTEXT"]);
    expect((await call("channelScope.listMemberships", { state: "joined" })).code).toBe("invalid_state");
    expect((await call("channelScope.listMemberships", { limit: 0 })).code).toBe("invalid_limit");
    expect((await call("channelScope.listMemberships", { employeeId: "emp_nope" })).code).toBe("employee_not_found");
    expect(JSON.stringify(all)).not.toContain("text");
  });
});

describe("pure helpers", () => {
  const p = (mode: "registered_only" | "all_joined", includeSlackConnect = false, allowed: string[] = []) => ({
    ...defaultChannelScopePolicy(),
    mode,
    includeSlackConnect,
    connect: { ...defaultChannelScopePolicy().connect, allowedExternalTeamIds: allowed },
  });
  test("widening detection", () => {
    expect(channelScopeWidens(null, p("all_joined"))).toBe(true);
    expect(channelScopeWidens(p("all_joined"), p("all_joined", true))).toBe(true);
    expect(channelScopeWidens(p("all_joined", true, ["T0A1"]), p("all_joined", true, []))).toBe(true);
    expect(channelScopeWidens(p("all_joined", true, ["T0A1"]), p("all_joined", true, ["T0A1", "T0B2"]))).toBe(true);
    expect(channelScopeWidens(p("all_joined", true), p("all_joined"))).toBe(false);
    expect(channelScopeWidens(p("all_joined"), p("registered_only"))).toBe(false);
  });
  test("state hash is key-order independent and layer-bound", () => {
    expect(channelScopeStateHash("org", null, { a: 1, b: 2 })).toBe(channelScopeStateHash("org", null, { b: 2, a: 1 }));
    expect(channelScopeStateHash("org", null, null)).not.toBe(channelScopeStateHash("employee", "e1", null));
    expect(channelScopeStateHash("employee", "e1", null)).not.toBe(channelScopeStateHash("employee", "e2", null));
  });
});
