/**
 * Admin MCP: employees.postingIdentity.set — demo mode, Slack auth.test faked.
 *
 * Covers: registry (name, always_human / approvalClass admin, plans, not
 * read-only, not on the employee MCP, no orgId argument), switch to user
 * without a token / without chat:write / normally, switch to bot (no token
 * check, no Slack call), another org's employeeId, the re-check right before
 * the write after approval (token deleted / scope lost after propose), and the
 * admin audit row (from / to, actor, approver, approvalId).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES, POSTING_IDENTITY_SET_TOOL } from "@/lib/admin-mcp/posting-identity-tool";
import { isRetryableApprovalFailure } from "@/lib/approvals/execution";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getApprovalById, listApprovals, resolveApproval, updateApprovalMetadata } from "@/lib/data";
import { runStuckWatchRetry } from "@/lib/stuck-watch/admin-handlers";
import { getStuckWatchItem } from "@/lib/stuck-watch/items";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  evaluateW2Eligibility,
  isApprovedUnfulfilled,
  processW2RetriesForApprovals,
  runW2FulfillRetry,
} from "@/lib/stuck-watch/w2-unfulfilled";
import { linkAgent } from "@/lib/data/bindings";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
  setDemoSlackIdentityStatusForTests,
} from "@/lib/data/slack-identities";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool, isAdminMcpToolName } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee, PostingAs } from "@/lib/types";

const TOOL = "employees.postingIdentity.set";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_posting_identity_other_tenant";
const TEAM = "T0POSTINGID1";
const SLACK_U = "U0C1RN0AHE1";
const ADMIN_GROK = "grok_admin_posting_identity";

// Fake user tokens (demo store only). auth.test answers by token.
const TOKEN_OK = "xoxp-posting-identity-ok";
const TOKEN_NO_CHAT_WRITE = "xoxp-posting-identity-no-chat-write";
const TOKEN_REVOKED = "xoxp-posting-identity-revoked";
const TOKEN_NO_SCOPE_HEADER = "xoxp-posting-identity-no-header";
const SCOPES_BY_TOKEN: Record<string, string | null> = {
  [TOKEN_OK]: "chat:write,users:read,im:history,files:write",
  [TOKEN_NO_CHAT_WRITE]: "users:read,im:history,files:write",
  [TOKEN_NO_SCOPE_HEADER]: null,
};

type Call = { url: string; auth: string };
let calls: Call[] = [];
let savedFetch: typeof globalThis.fetch;
let seq = 0;

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ url: href, auth });
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (href === "https://slack.com/api/auth.test") {
      const token = auth.replace(/^Bearer /, "");
      if (token === TOKEN_REVOKED) return json({ ok: false, error: "token_revoked" });
      if (!(token in SCOPES_BY_TOKEN)) return json({ ok: false, error: "invalid_auth" });
      const scopes = SCOPES_BY_TOKEN[token];
      return json({ ok: true, user_id: SLACK_U, team_id: TEAM }, scopes === null ? {} : { "x-oauth-scopes": scopes });
    }
    // Approval notifications etc.: local fake, never the network.
    return json({ ok: true });
  }) as unknown as typeof fetch;
}

function slackAuthTestCalls(): Call[] {
  return calls.filter((c) => c.url === "https://slack.com/api/auth.test");
}

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: ADMIN_GROK, status: "linked" });
  return {
    orgId,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function newEmployee(orgId: string, postingAs: PostingAs, extra: Partial<Employee> = {}): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_pi_${Date.now().toString(36)}_${seq}`,
    orgId,
    displayName: "稲盛",
    status: "active",
    postingAs,
    allowedAccounts: [{ service: "slack", accountId: SLACK_U }],
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function runtimeEmployee(id: string): Employee | undefined {
  return getRuntimeEmployees().find((e) => e.id === id);
}

async function linkSlack(emp: Employee, userToken = TOKEN_OK) {
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: emp.orgId,
    slackUserId: SLACK_U,
    slackTeamId: TEAM,
    displayName: "inamori",
    userToken,
  });
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

async function approveAndFulfill(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_pi" });
  expect(approved).not.toBeNull();
  return fulfillApprovedAdmin(approved!);
}

async function approvalCount(orgId = ORG_A): Promise<number> {
  return (await listApprovals(orgId)).length;
}

function auditFor(approvalId: string, event: string) {
  return getRuntimeAudit().find((e) => e.metadata?.approvalId === approvalId && e.metadata?.event === event);
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

describe("registry", () => {
  test("exact name on the admin MCP (tools/list and callable), exported constant agrees", () => {
    expect(POSTING_IDENTITY_SET_TOOL).toBe(TOOL);
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(TOOL)).toBe(true);
    expect(ADMIN_MCP_TOOLS.some((t) => t.name === TOOL)).toBe(true);
    expect(isAdminMcpToolName(TOOL)).toBe(true);
  });

  test("always_human, approvalClass admin, admin.policy audit, not read-only", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    expect(tool.approvalClass).toBe("admin");
    expect(tool.description).toContain("always_human");
    expect(tool.description).not.toMatch(/NOT (wrapped in another )?always_human/i);
    expect(tool.description).not.toContain("read-only");
    expect(auditActionForAdminTool(TOOL)).toBe("admin.policy");
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(TOOL)).toBe(false);
  });

  test("schema: employeeId + postingAs (bot | user), no orgId, no extra keys", () => {
    const schema = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["approvalId", "employeeId", "jobId", "postingAs"]);
    expect(schema.properties.postingAs.enum).toEqual(["bot", "user"]);
    expect(schema.required).toEqual(["employeeId", "postingAs"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("available on every tenant plan (same as employees.issue / allowedAccounts)", () => {
    for (const plan of Object.keys(PLAN_ADMIN_SCOPES) as Array<keyof typeof PLAN_ADMIN_SCOPES>) {
      const scopes = PLAN_ADMIN_SCOPES[plan] as readonly string[];
      expect({ plan, ok: scopes.includes(TOOL) }).toEqual({ plan, ok: true });
    }
  });

  test("absent from the employee badge MCP (/api/mcp)", async () => {
    const employeeNames = [...STAFFPASS_MCP_TOOLS, ...listStaffpassMcpTools()].map((t) => t.name);
    expect(employeeNames.includes(TOOL)).toBe(false);
    const emp = newEmployee(ORG_A, "bot");
    const res = await callStaffpassMcpTool(TOOL, {}, { employeeId: emp.id, orgId: ORG_A } as unknown as ResolvedEmployeeCredential);
    expect(data(res).code).toBe("unknown_mcp_tool");
  });
});

describe("switch to user: token check at propose time (no ticket, no change)", () => {
  test("no Slack identity → user_token_missing", async () => {
    const emp = newEmployee(ORG_A, "bot");
    const before = await approvalCount();
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("user_token_missing");
    expect(String(data(res).message)).toContain("Slack");
    expect(String(data(res).nextStepJa || "")).not.toBe("");
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
  });

  test("identity needs re-authorization (no usable token) → user_token_missing", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    setDemoSlackIdentityStatusForTests(emp.id, "needs_reauth");
    const before = await approvalCount();
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("user_token_missing");
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("token without chat:write → missing_scope_chat_write", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    const before = await approvalCount();
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("missing_scope_chat_write");
    expect(data(res).missingScopes).toEqual(["chat:write"]);
    expect(String(data(res).message)).toContain("chat:write");
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("token rejected by Slack → user_token_invalid (fail closed)", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp, TOKEN_REVOKED);
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("user_token_invalid");
    expect(res.slackError).toBe("token_revoked");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("granted scopes cannot be read → user_token_scope_check_failed (fail closed)", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp, TOKEN_NO_SCOPE_HEADER);
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("user_token_scope_check_failed");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("the token never appears in the MCP result", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred());
    expect(JSON.stringify(res)).not.toContain("xoxp-");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });
});

describe("switch to user: normal path", () => {
  test("queues an always_human ticket; applied only after approval; audit has from/to/actor/approver/approvalId", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const c = cred();
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, c);
    const out = data(res);
    expect(res.isError).toBe(false);
    expect(out.code).toBe("needs_approval");
    expect(out.always_human).toBe(true);
    expect(String(out.summary)).toContain("社員「稲盛」");
    expect(String(out.summary)).toContain(SLACK_U);
    expect(JSON.stringify(out)).not.toContain("xoxp-");
    const approvalId = String(out.approvalId);
    const ticket = await getApprovalById(approvalId, ORG_A);
    expect(ticket?.status).toBe("pending");
    expect(ticket?.metadata?.adminTool).toBe(TOOL);
    expect(ticket?.metadata?.adminMutation).toMatchObject({ employeeId: emp.id, postingAs: "user" });
    expect(JSON.stringify(ticket?.metadata ?? {})).not.toContain("xoxp-");
    // Checked once at propose time (auth.test with the employee's own token).
    expect(slackAuthTestCalls().map((c2) => c2.auth)).toEqual([`Bearer ${TOKEN_OK}`]);
    // Not applied yet.
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    const pending = data(await callAdminMcpTool(TOOL, { approvalId }, c));
    expect(pending.code).toBe("needs_approval");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");

    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.employeeId).toBe(emp.id);
    expect(String(fulfillment?.summaryJa)).toContain("本人");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    // Checked again right before the write (second auth.test).
    expect(slackAuthTestCalls().length).toBe(2);

    const audit = auditFor(approvalId, "employee.posting_as.changed");
    expect(audit).toBeTruthy();
    expect(audit!.orgId).toBe(ORG_A);
    expect(audit!.action).toBe("admin.policy");
    expect(audit!.employeeId).toBe(emp.id);
    expect(audit!.metadata?.actorEmail).toBe("owner@example.com");
    expect(audit!.metadata).toMatchObject({
      auditClass: "admin",
      tool: TOOL,
      approvalId,
      employeeId: emp.id,
      from: "bot",
      to: "user",
      postingAs: "user",
      slackUserId: SLACK_U,
      approver: "owner@example.com",
      actor: { kind: "admin_agent", adminAgentId: c.adminAgentId, grokBotAgentId: ADMIN_GROK },
    });
    expect(JSON.stringify(audit)).not.toContain("xoxp-");

    // Re-invoke reads the stored result; not applied twice.
    const read = data(await callAdminMcpTool(TOOL, { approvalId }, c));
    expect(read.ok).toBe(true);
    expect(getRuntimeAudit().filter((e) => e.metadata?.approvalId === approvalId && e.metadata?.event === "employee.posting_as.changed")).toHaveLength(1);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("rejected ticket: no change", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    await resolveApproval(String(out.approvalId), "rejected", "owner@example.com", ORG_A, { actorId: "mem_human_pi" });
    const again = data(await callAdminMcpTool(TOOL, { approvalId: out.approvalId }, cred()));
    expect(again.code).toBe("approval_rejected");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });
});

describe("re-check right before the write (after approval)", () => {
  test("token deleted after propose → refused with user_token_missing, no change, rejected audit", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(out.code).toBe("needs_approval");
    const approvalId = String(out.approvalId);
    // Unlinked on the dashboard while the ticket was pending.
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("user_token_missing");
    expect(String(fulfillment?.nextStepJa || "")).not.toBe("");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(auditFor(approvalId, "employee.posting_as.changed")).toBeUndefined();
    const rejected = auditFor(approvalId, "employee.posting_as.rejected");
    expect(rejected?.metadata).toMatchObject({ code: "user_token_missing", from: "bot", to: "user", tool: TOOL });
    // Stored on the ticket (what approval polling returns).
    const persisted = parseAdminFulfillment((await getApprovalById(approvalId, ORG_A))?.metadata);
    expect(persisted?.error).toBe("user_token_missing");
  });

  test("re-linked with a token that lacks chat:write after propose → missing_scope_chat_write, no change", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("missing_scope_chat_write");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("tampered ticket payload is re-validated (postingAs must be bot | user)", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approval = await getApprovalById(String(out.approvalId), ORG_A);
    (approval!.metadata!.adminMutation as Record<string, unknown>).postingAs = "admin";
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("invalid_posting_as");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("suspended after propose → employee_terminated, no change", async () => {
    const emp = newEmployee(ORG_A, "user");
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    runtimeEmployee(emp.id)!.status = "suspended";
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_terminated");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
  });

  test("already switched meanwhile (e.g. on the dashboard) → ok, unchanged, no second write", async () => {
    const emp = newEmployee(ORG_A, "user");
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    runtimeEmployee(emp.id)!.postingAs = "bot";
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(String(fulfillment?.summaryJa)).toContain("既に");
    expect(auditFor(approvalId, "employee.posting_as.unchanged")?.metadata).toMatchObject({ from: "bot", to: "bot" });
    expect(auditFor(approvalId, "employee.posting_as.changed")).toBeUndefined();
  });
});

describe("switch to bot", () => {
  test("no token check (no Slack call), ticket, applied after approval, audited user → bot", async () => {
    const emp = newEmployee(ORG_A, "user");
    const c = cred();
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, c));
    expect(out.code).toBe("needs_approval");
    expect(String(out.summary)).toContain("会社のBot");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(slackAuthTestCalls()).toHaveLength(0);
    const audit = auditFor(approvalId, "employee.posting_as.changed");
    expect(audit?.action).toBe("admin.policy");
    expect(audit?.metadata).toMatchObject({
      auditClass: "admin",
      tool: TOOL,
      approvalId,
      from: "user",
      to: "bot",
      approver: "owner@example.com",
      actor: { kind: "admin_agent", adminAgentId: c.adminAgentId, grokBotAgentId: ADMIN_GROK },
    });
  });

  test("works even when the user token is missing or broken", async () => {
    const emp = newEmployee(ORG_A, "user");
    await linkSlack(emp, TOKEN_REVOKED);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    expect(out.code).toBe("needs_approval");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(slackAuthTestCalls()).toHaveLength(0);
  });
});

describe("no-op and argument checks", () => {
  test("already the requested identity → ok already_set, no ticket, no Slack call", async () => {
    const emp = newEmployee(ORG_A, "bot");
    const before = await approvalCount();
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred());
    expect(res.isError).toBe(false);
    expect(data(res)).toMatchObject({ ok: true, code: "already_set", changed: false, postingAs: "bot" });
    expect(await approvalCount()).toBe(before);
    expect(slackAuthTestCalls()).toHaveLength(0);
  });

  test("postingAs must be exactly bot | user; employeeId required; secrets / unknown keys rejected", async () => {
    const emp = newEmployee(ORG_A, "bot");
    const before = await approvalCount();
    for (const bad of ["User", "admin", "", 1, null]) {
      const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: bad }, cred()));
      expect({ bad, code: res.code }).toEqual({ bad, code: "invalid_posting_as" });
    }
    expect(data(await callAdminMcpTool(TOOL, { postingAs: "bot" }, cred())).code).toBe("missing_required_fields");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user", userToken: "x" }, cred())).code).toBe(
      "secret_not_accepted"
    );
    expect(data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user", slackUserId: SLACK_U }, cred())).code).toBe(
      "unexpected_argument"
    );
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
  });

  test("suspended employee → employee_terminated, no ticket", async () => {
    const emp = newEmployee(ORG_A, "user", { status: "suspended" });
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    expect(res.code).toBe("employee_terminated");
  });

  test("admin agent cannot switch the badge bound to itself", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    await linkAgent(emp.id, { orgId: ORG_A, grokBotAgentId: ADMIN_GROK, grokBotWorkspaceId: null });
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("cannot_target_self");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });
});

describe("org boundary", () => {
  test("another org's employee is 'not found' — same answer as a non-existent id, no ticket, no Slack call", async () => {
    const empB = newEmployee(ORG_B, "bot");
    await linkSlack(empB);
    const before = await approvalCount();
    for (const postingAs of ["user", "bot"] as const) {
      const other = await callAdminMcpTool(TOOL, { employeeId: empB.id, postingAs }, cred(ORG_A));
      const missing = await callAdminMcpTool(TOOL, { employeeId: "emp_does_not_exist", postingAs }, cred(ORG_A));
      expect(other.isError).toBe(true);
      expect(data(other)).toEqual(data(missing));
      expect(data(other).code).toBe("employee_not_found");
      expect(JSON.stringify(data(other))).not.toContain(SLACK_U);
    }
    expect(await approvalCount()).toBe(before);
    expect(slackAuthTestCalls()).toHaveLength(0);
    expect(runtimeEmployee(empB.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: empB.id, orgId: empB.orgId });
  });

  test("orgId argument is rejected (never taken from tool arguments)", async () => {
    const empB = newEmployee(ORG_B, "bot");
    const res = data(await callAdminMcpTool(TOOL, { employeeId: empB.id, postingAs: "bot", orgId: ORG_B }, cred(ORG_A)));
    expect(res.code).toBe("unexpected_argument");
    expect(runtimeEmployee(empB.id)!.postingAs).toBe("bot");
  });

  test("fulfillment uses the approval's org: an employee moved out of the org is not found", async () => {
    const emp = newEmployee(ORG_A, "user");
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    runtimeEmployee(emp.id)!.orgId = ORG_B;
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_not_found");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
  });

  test("identity row of another org is not accepted as this employee's token", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    // Simulate a mismatched identity row (org moved): the identity says ORG_B.
    runtimeEmployee(emp.id)!.orgId = ORG_B;
    await linkSlack(runtimeEmployee(emp.id)!);
    runtimeEmployee(emp.id)!.orgId = ORG_A;
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("user_token_missing");
    expect(slackAuthTestCalls()).toHaveLength(0);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG_B });
  });
});

/**
 * 木村 decision 2: when the badge's allowedAccounts has at least one Slack row,
 * the linked identity's Slack user ID must be one of them (same exact match as
 * bindEmployeeSlackIdentity / employeeAllowsSlackUser). No Slack row at all →
 * unchanged behavior. Checked at propose time and right before the write.
 */
describe("switch to user: linked Slack user must be in allowedAccounts (when it has Slack rows)", () => {
  const OTHER_U = "U0OTHERPI01";

  test("Slack rows exist but not the linked U… → slack_account_not_allowed, no ticket, no Slack call", async () => {
    const emp = newEmployee(ORG_A, "bot", { allowedAccounts: [{ service: "slack", accountId: SLACK_U }] });
    await linkSlack(emp);
    // Removed from allowedAccounts after linking (the identity stays linked, #242).
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: OTHER_U }];
    const before = await approvalCount();
    const res = await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("slack_account_not_allowed");
    expect(String(data(res).message)).toContain(SLACK_U);
    expect(String(data(res).nextStepJa || "")).not.toBe("");
    expect(await approvalCount()).toBe(before);
    expect(slackAuthTestCalls()).toHaveLength(0);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("linked U… is among several Slack rows → allowed (ticket)", async () => {
    const emp = newEmployee(ORG_A, "bot", {
      allowedAccounts: [
        { service: "slack", accountId: OTHER_U },
        { service: "slack", accountId: SLACK_U },
        { service: "google", accountId: "sales@example.co.jp", browserRequired: true },
      ],
    });
    await linkSlack(emp);
    const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(res.code).toBe("needs_approval");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("no Slack row at all (empty, or only other services) → today's behavior (ticket)", async () => {
    for (const accounts of [[], [{ service: "google", accountId: "sales@example.co.jp", browserRequired: true }]]) {
      const emp = newEmployee(ORG_A, "bot", { allowedAccounts: [{ service: "slack", accountId: SLACK_U }] });
      await linkSlack(emp);
      runtimeEmployee(emp.id)!.allowedAccounts = accounts;
      const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
      expect({ accounts: accounts.length, code: res.code }).toEqual({ accounts: accounts.length, code: "needs_approval" });
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    }
  });

  test("Slack rows are matched like bind: service case-insensitive, accountId exact (non-U… formats do not match → refused)", async () => {
    const cases: Array<{ row: { service: string; accountId: string }; code: string }> = [
      { row: { service: " Slack ", accountId: ` ${SLACK_U} ` }, code: "needs_approval" },
      { row: { service: "SLACK", accountId: SLACK_U.toLowerCase() }, code: "slack_account_not_allowed" },
      { row: { service: "slack", accountId: `<@${SLACK_U}>` }, code: "slack_account_not_allowed" },
      { row: { service: "slack", accountId: `${TEAM}/${SLACK_U}` }, code: "slack_account_not_allowed" },
    ];
    for (const c of cases) {
      const emp = newEmployee(ORG_A, "bot", { allowedAccounts: [{ service: "slack", accountId: SLACK_U }] });
      await linkSlack(emp);
      runtimeEmployee(emp.id)!.allowedAccounts = [c.row];
      const res = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
      expect({ row: c.row, code: res.code }).toEqual({ row: c.row, code: c.code });
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    }
  });

  test("removed from allowedAccounts after propose → refused right before the write, .rejected audit, no change", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(out.code).toBe("needs_approval");
    const approvalId = String(out.approvalId);
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: OTHER_U }];
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("slack_account_not_allowed");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(auditFor(approvalId, "employee.posting_as.changed")).toBeUndefined();
    expect(auditFor(approvalId, "employee.posting_as.rejected")?.metadata).toMatchObject({
      code: "slack_account_not_allowed",
      from: "bot",
      to: "user",
      tool: TOOL,
    });
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("稲盛 case: U0C1RN0AHE1 is on the list → not affected", async () => {
    const emp = newEmployee(ORG_A, "bot", { allowedAccounts: [{ service: "slack", accountId: "U0C1RN0AHE1" }] });
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    expect(out.code).toBe("needs_approval");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("switching to bot ignores allowedAccounts", async () => {
    const emp = newEmployee(ORG_A, "user", { allowedAccounts: [{ service: "slack", accountId: OTHER_U }] });
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "bot" }, cred()));
    expect(out.code).toBe("needs_approval");
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
  });
});

/**
 * 木村 decision 3: re-invoking with the same approvalId after a FAILED run
 * re-runs the fulfillment, and every run redoes every check against the
 * current state. A SUCCESSFUL run is stored and returned as is (no re-run).
 */
describe("re-invoke with the same approvalId redoes every check", () => {
  const OTHER_U = "U0OTHERPI02";

  async function reinvoke(approvalId: string) {
    return data(await callAdminMcpTool(TOOL, { approvalId }, cred()));
  }

  // The shared re-invoke response (readApprovedAdminResult) returns ok +
  // nextStepJa but not the code; the code of the latest run is in the stored result.
  async function storedError(approvalId: string) {
    return parseAdminFulfillment((await getApprovalById(approvalId, ORG_A))?.metadata)?.error;
  }

  test("token missing at the first run → fails; after re-authorizing, the same approvalId succeeds", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    const first = await approveAndFulfill(approvalId);
    expect(first?.error).toBe("user_token_missing");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    // Re-authorized (e.g. #240 link) → re-invoke the same ticket.
    await linkSlack(emp);
    const second = await reinvoke(approvalId);
    expect(second.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    expect(auditFor(approvalId, "employee.posting_as.changed")?.metadata).toMatchObject({ from: "bot", to: "user", approvalId });
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("scope missing at the first run → fails; after re-authorizing with chat:write, the same approvalId succeeds", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    expect((await approveAndFulfill(approvalId))?.error).toBe("missing_scope_chat_write");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await linkSlack(emp, TOKEN_OK);
    const authBefore = slackAuthTestCalls().length;
    expect((await reinvoke(approvalId)).ok).toBe(true);
    expect(slackAuthTestCalls().length).toBe(authBefore + 1);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("token + allowedAccounts passed at the first run (failed on scope); on the re-call the token is gone → user_token_missing", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    expect((await approveAndFulfill(approvalId))?.error).toBe("missing_scope_chat_write");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    const second = await reinvoke(approvalId);
    expect(second.ok).toBe(false);
    expect(await storedError(approvalId)).toBe("user_token_missing");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    const rejected = getRuntimeAudit().filter((e) => e.metadata?.approvalId === approvalId && e.metadata?.event === "employee.posting_as.rejected");
    const codes = rejected.map((e) => e.metadata?.code);
    expect(codes).toContain("missing_scope_chat_write");
    expect(codes).toContain("user_token_missing");
  });

  test("token + allowedAccounts passed at the first run (failed on scope); on the re-call the account was removed from allowedAccounts → slack_account_not_allowed", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    await linkSlack(emp, TOKEN_NO_CHAT_WRITE);
    expect((await approveAndFulfill(approvalId))?.error).toBe("missing_scope_chat_write");
    // Re-authorized with chat:write, but the U… was removed from allowedAccounts meanwhile.
    await linkSlack(emp, TOKEN_OK);
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: OTHER_U }];
    const second = await reinvoke(approvalId);
    expect(second.ok).toBe(false);
    expect(await storedError(approvalId)).toBe("slack_account_not_allowed");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("a successful run is stored: re-invoking later returns it without re-running or writing again", async () => {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    expect((await approveAndFulfill(approvalId))?.ok).toBe(true);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    runtimeEmployee(emp.id)!.postingAs = "bot";
    const authBefore = slackAuthTestCalls().length;
    const again = await reinvoke(approvalId);
    expect(again.ok).toBe(true);
    expect(slackAuthTestCalls().length).toBe(authBefore);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(getRuntimeAudit().filter((e) => e.metadata?.approvalId === approvalId && e.metadata?.event === "employee.posting_as.changed")).toHaveLength(1);
  });
});

describe("execution claim: which failures may be re-run with the same approvalId", () => {
  test("the five pre-write refusals of this tool are re-runnable (state failed), only for this tool", () => {
    expect([...POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES].sort()).toEqual([
      "missing_scope_chat_write",
      "slack_account_not_allowed",
      "user_token_invalid",
      "user_token_missing",
      "user_token_scope_check_failed",
    ]);
    for (const code of POSTING_IDENTITY_RETRYABLE_REFUSAL_CODES) {
      expect({ code, retry: isRetryableApprovalFailure(TOOL, code) }).toEqual({ code, retry: true });
      // Other tools keep their own rules (e.g. #240 also has slack_account_not_allowed / user_token_missing).
      expect({ code, retry: isRetryableApprovalFailure("setup.slackAuthorizeLink.issue", code) }).toEqual({ code, retry: false });
      expect({ code, retry: isRetryableApprovalFailure("employees.allowedAccounts.add", code) }).toEqual({ code, retry: false });
    }
  });

  test("a failed write is NOT re-runnable (outcome may be partial → uncertain); shared codes unchanged", () => {
    for (const code of ["employee_policy_update_failed", "employee_policy_credentials_update_failed", "invalid_posting_as", "employee_not_found", ""]) {
      expect({ code, retry: isRetryableApprovalFailure(TOOL, code) }).toEqual({ code, retry: false });
    }
    expect(isRetryableApprovalFailure(TOOL, "slack_token_missing")).toBe(true);
    expect(isRetryableApprovalFailure("anything", "missing_scope")).toBe(true);
  });
});

/**
 * 木村 decision: a posting identity switch changes what the other side sees,
 * so a person must know when it happens. W2 (stuck-watch auto retry) never
 * re-runs this tool's re-runnable ticket; only an explicit re-invoke with the
 * approvalId does.
 */
describe("W2 never re-runs employees.postingIdentity.set (explicit approvalId re-invoke only)", () => {
  async function reinvoke(approvalId: string) {
    return data(await callAdminMcpTool(TOOL, { approvalId }, cred()));
  }

  /** A re-runnable ticket (failed with user_token_missing), aged past W2's threshold, cause fixed. */
  async function failedTicketReadyForW2() {
    const emp = newEmployee(ORG_A, "bot");
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: emp.id, postingAs: "user" }, cred()));
    const approvalId = String(out.approvalId);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    expect((await approveAndFulfill(approvalId))?.error).toBe("user_token_missing");
    await linkSlack(emp); // re-authorized: a W2 run would now succeed
    const stored = (await getApprovalById(approvalId, ORG_A))!;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await updateApprovalMetadata(stored, {
      ...stored.metadata,
      stuckWatch: { w2: { firstDetectedAt: tenMinutesAgo, retryCount: 0 } },
    });
    const approval = (await getApprovalById(approvalId, ORG_A))!;
    return { emp, approvalId, approval };
  }

  function w2Audits(approvalId: string) {
    return getRuntimeAudit().filter((e) => e.action === "stuck_watch.w2_retry" && e.metadata?.approvalId === approvalId);
  }

  test("cron path: W2 skips the re-runnable ticket even with retries left; nothing runs or changes", async () => {
    const { emp, approvalId, approval } = await failedTicketReadyForW2();
    expect(isApprovedUnfulfilled(approval)).toBe(true);
    expect(evaluateW2Eligibility({ approval, policy: defaultStuckWatchPolicy(), now: new Date() })).toMatchObject({
      eligible: false,
      reason: "manual_reinvoke_required",
      retryCount: 0,
    });
    const authBefore = slackAuthTestCalls().length;
    expect(await processW2RetriesForApprovals([approval])).toEqual([]);
    expect(await runW2FulfillRetry(approval, defaultStuckWatchPolicy())).toMatchObject({
      ok: false,
      skipped: true,
      reason: "manual_reinvoke_required",
      retryCount: 0,
    });
    expect(slackAuthTestCalls().length).toBe(authBefore);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(auditFor(approvalId, "employee.posting_as.changed")).toBeUndefined();
    expect(w2Audits(approvalId)).toEqual([]);
    const after = (await getApprovalById(approvalId, ORG_A))!;
    expect((after.metadata?.stuckWatch as { w2?: { retryCount?: number } })?.w2?.retryCount).toBe(0);
    expect(parseAdminFulfillment(after.metadata)?.error).toBe("user_token_missing");
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("stuck-watch item says manual re-invoke is needed; stuckWatch.retry does not run it either", async () => {
    const { emp, approvalId } = await failedTicketReadyForW2();
    const itemId = `w2:${approvalId}`;
    const item = await getStuckWatchItem(ORG_A, itemId);
    expect(item).not.toBeNull();
    expect(item!.status).toBe("open");
    expect(item!.stuckHint).toBe("fix");
    expect(item!.metadata).toMatchObject({ w2Eligible: false, w2Reason: "manual_reinvoke_required" });
    expect(item!.nextStepJa).toContain(TOOL);
    expect(item!.nextStepJa).toContain("approvalId");
    const authBefore = slackAuthTestCalls().length;
    const res = await runStuckWatchRetry(ORG_A, { itemId }, "mem_human_pi");
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe("manual_reinvoke_required");
    expect(String((res as { nextStepJa?: string }).nextStepJa)).toContain(TOOL);
    expect(slackAuthTestCalls().length).toBe(authBefore);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    expect(w2Audits(approvalId)).toEqual([]);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("after W2 skipped it, an explicit re-invoke with the approvalId still runs and redoes every check", async () => {
    const { emp, approvalId, approval } = await failedTicketReadyForW2();
    expect(await processW2RetriesForApprovals([approval])).toEqual([]);
    // Re-check proves it runs again from scratch: removed from allowedAccounts → refused.
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: "U0OTHERPI03" }];
    expect((await reinvoke(approvalId)).ok).toBe(false);
    expect(parseAdminFulfillment((await getApprovalById(approvalId, ORG_A))?.metadata)?.error).toBe("slack_account_not_allowed");
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("bot");
    // Fixed → the same approvalId succeeds (token + scope checked again).
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: SLACK_U }];
    const authBefore = slackAuthTestCalls().length;
    expect((await reinvoke(approvalId)).ok).toBe(true);
    expect(slackAuthTestCalls().length).toBe(authBefore + 1);
    expect(runtimeEmployee(emp.id)!.postingAs).toBe("user");
    expect(auditFor(approvalId, "employee.posting_as.changed")?.metadata).toMatchObject({ from: "bot", to: "user", approvalId });
    expect(w2Audits(approvalId)).toEqual([]);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });
});
