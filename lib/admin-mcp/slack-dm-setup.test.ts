/**
 * PR-4 admin MCP tools — demo mode, Slack mocked.
 * Covers: admin-MCP-only (absent from /api/mcp), read-only vs always_human,
 * autoResolve always_human even with ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY, org_id
 * from credential only (cross-org leak), no secrets accepted / returned,
 * deep link + missing scopes, users:read next step, dryRun has no side effects.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { SLACK_DM_SETUP_TOOLS } from "@/lib/admin-mcp/slack-dm-setup";
import { READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { resolveApproval } from "@/lib/data";
import { linkAgent } from "@/lib/data/bindings";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { upsertOrgParty } from "@/lib/data/directory";
import {
  listNotificationChannels,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { listSlackImRoutesByOrg, upsertSlackImEmployeeRoute } from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { APPROVAL_SETUP_NOTICE_TEXT } from "@/lib/slack/approval-dm-open";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee } from "@/lib/types";

const ORG_A = DEMO_ORG.id;
const ORG_B = "org_pr4_other_tenant";
const TEAM = "TPR4TEAM01";
const USER_TOKEN = "xoxp-pr4-user-SECRET-111";
const BOT_TOKEN = "xoxb-pr4-approval-SECRET-222";
const BOT_TOKEN_B = "xoxb-pr4-orgb-SECRET-333";
const APPROVER = "UAPPROVER01";
const STRANGER = "USTRANGER01";
const COLLEAGUE = "UCOLLEAGUE1";
const FLAGS = [
  "SLACK_DM_AUTOROUTE_ENABLED",
  "SLACK_APPROVAL_DM_AUTO_OPEN",
  "ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY",
  "SLACK_USER_SCOPE_IM_WRITE",
] as const;

type Call = { method: string; body: Record<string, unknown>; auth: string };
let calls: Call[] = [];
let botScopes = "chat:write,im:write,im:read,users:read";
let usersInfoMissingScope = false;
let savedFetch: typeof globalThis.fetch;
let saved: Record<string, string | undefined> = {};
let empA: Employee;
let empB: Employee;
let empASlackUser = "";
let seq = 0;

const users: Record<string, Record<string, unknown>> = {
  [APPROVER]: { id: APPROVER, team_id: TEAM },
  [COLLEAGUE]: { id: COLLEAGUE, team_id: TEAM },
  [STRANGER]: { id: STRANGER, team_id: "TOTHER0001", is_stranger: true },
};

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_pr4", status: "linked" });
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

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const body = init?.body ? JSON.parse(String(init.body) || "{}") : {};
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ method, body, auth });
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
    const isUser = auth.endsWith(USER_TOKEN);
    if (method === "auth.test") {
      if (isUser) return json({ ok: true, user_id: empASlackUser, team_id: TEAM }, { "x-oauth-scopes": "im:write,users:read,chat:write" });
      return json({ ok: true, user_id: "UBOT", team_id: TEAM, app_id: "APR4APP01" }, { "x-oauth-scopes": botScopes });
    }
    if (method === "users.info") {
      if (usersInfoMissingScope && !isUser) return json({ ok: false, error: "missing_scope", needed: "users:read" });
      const user = users[String(body.user)];
      return user ? json({ ok: true, user }) : json({ ok: false, error: "user_not_found" });
    }
    if (method === "conversations.open") {
      return json({ ok: true, channel: { id: `D${String(body.users).slice(1, 9)}X${isUser ? "U" : "B"}`, is_im: true } });
    }
    if (method === "chat.postMessage") return json({ ok: true, ts: "1700000000.0001" });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function newEmployee(orgId: string, slackUserId: string): Employee {
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_pr4_${Date.now().toString(36)}_${seq}_${orgId.length}`,
    orgId,
    status: "active",
    allowedAccounts: [{ service: "slack", accountId: slackUserId }],
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function noSecrets(value: unknown) {
  const blob = JSON.stringify(value);
  for (const secret of [USER_TOKEN, BOT_TOKEN, BOT_TOKEN_B, "SECRET"]) expect(blob).not.toContain(secret);
}

async function seedInbox(orgId: string, token: string, opts: { channelId?: string; allowed?: string[] } = {}) {
  return upsertNotificationChannel({
    orgId,
    provider: "slack",
    enabled: true,
    isDefault: true,
    label: `承認 ${orgId}`,
    config: { channelId: opts.channelId ?? "", allowedUserIds: opts.allowed ?? [APPROVER] },
    secrets: { botToken: token, signingSecret: "sig-SECRET" },
  });
}

async function approveAndFulfill(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_pr4" });
  return fulfillApprovedAdmin(approved!);
}

beforeEach(async () => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
  process.env.SLACK_APPROVAL_DM_AUTO_OPEN = "true";
  delete process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY;
  botScopes = "chat:write,im:write,im:read,users:read";
  usersInfoMissingScope = false;
  savedFetch = globalThis.fetch;
  installFetch();
  resetDemoNotificationChannels();
  seq += 1;
  empASlackUser = `UEMPA${seq}`;
  empA = newEmployee(ORG_A, empASlackUser);
  empB = newEmployee(ORG_B, `UEMPB${seq}`);
  await bindEmployeeSlackIdentity({ employeeId: empA.id, orgId: ORG_A, slackUserId: empASlackUser, slackTeamId: TEAM, displayName: "A", userToken: USER_TOKEN });
  await bindEmployeeSlackIdentity({ employeeId: empB.id, orgId: ORG_B, slackUserId: `UEMPB${seq}`, slackTeamId: "TORGB00001", displayName: "B", userToken: USER_TOKEN });
  await upsertOrgParty({ orgId: ORG_A, kind: "slack_user", identifier: COLLEAGUE, audience: "internal" });
  await upsertOrgParty({ orgId: ORG_B, kind: "slack_user", identifier: "UORGBPARTY", audience: "internal" });
  await upsertSlackImEmployeeRoute({ orgId: ORG_B, slackChannelId: "DORGBROUTE1", slackTeamId: "TORGB00001", employeeId: empB.id });
  await seedInbox(ORG_B, BOT_TOKEN_B, { channelId: "DORGBDEST01" });
});

afterEach(async () => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId: empA.id, orgId: ORG_A });
  await revokeEmployeeSlackIdentity({ employeeId: empB.id, orgId: ORG_B });
});

describe("registry: admin MCP only", () => {
  test("4 tools on admin MCP, absent from employee MCP (/api/mcp)", async () => {
    const employeeNames = [...STAFFPASS_MCP_TOOLS, ...listStaffpassMcpTools()].map((t) => t.name);
    for (const name of SLACK_DM_SETUP_TOOLS) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
      expect(ADMIN_MCP_TOOLS.some((t) => t.name === name)).toBe(true);
      expect(employeeNames.includes(name)).toBe(false);
      const res = await callStaffpassMcpTool(name, {}, { employeeId: empA.id, orgId: ORG_A } as unknown as ResolvedEmployeeCredential);
      expect(res.isError).toBe(true);
      expect(data(res).code).toBe("unknown_mcp_tool");
    }
  });

  test("read-only vs always_human labelling; autoResolve is never read-only", () => {
    const desc = (n: string) => ADMIN_MCP_TOOLS.find((t) => t.name === n)!.description;
    expect(desc("setup.slackDmApprovalStatus")).toContain("read-only");
    expect(desc("dmAutoroute.list")).toContain("read-only");
    expect(desc("dmAutoroute.run")).toContain("always_human");
    expect(desc("setup.approvalDelivery.autoResolve")).toContain("always_human");
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes("setup.approvalDelivery.autoResolve")).toBe(false);
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes("dmAutoroute.run")).toBe(false);
    expect(auditActionForAdminTool("dmAutoroute.run")).toBe("admin.channel");
    expect(auditActionForAdminTool("setup.approvalDelivery.autoResolve")).toBe("admin.notificationChannel");
  });
});

describe("setup.slackDmApprovalStatus", () => {
  test("no approval inbox: next steps include App B creation and users:read", async () => {
    const out = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect(out.ok).toBe(true);
    expect(out.testApprovalRequired).toBe(false);
    const steps = (out.nextStepsJa as string[]).join("\n");
    expect(steps).toContain("users:read");
    expect(steps).toContain("承認アプリ");
    noSecrets(out);
  });

  test("approval bot lacks users:read: missingScopes + deep link + next step", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    botScopes = "chat:write,im:write,im:read";
    const out = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    const missing = out.missingScopes as Array<Record<string, string>>;
    expect(missing.some((m) => m.scope === "users:read" && m.app === "approval_app" && m.url.startsWith("https://api.slack.com/apps"))).toBe(true);
    expect((out.nextStepsJa as string[]).some((s) => s.includes("users:read") && s.includes("https://api.slack.com/apps"))).toBe(true);
    expect(out.approvalBotUsersReadVerified).toBe(false);
    noSecrets(out);
  });

  test("users:read present: no users:read step; tenant isolation (no org B ids)", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    const out = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect(out.approvalBotUsersReadVerified).toBe(true);
    expect((out.nextStepsJa as string[]).some((s) => s.includes("users:read を追加"))).toBe(false);
    const blob = JSON.stringify(out);
    expect(blob).not.toContain(empB.id);
    expect(blob).not.toContain("DORGBDEST01");
    expect(blob).not.toContain(ORG_B);
    expect((out.employees as Array<Record<string, unknown>>).some((e) => e.employeeId === empA.id)).toBe(true);
    noSecrets(out);
  });
});

describe("secrets and org_id", () => {
  test("token-looking args / secret keys / orgId override are rejected", async () => {
    for (const [tool, args] of [
      ["dmAutoroute.run", { botToken: "xoxb-1" }],
      ["dmAutoroute.run", { employeeId: "xoxp-123-abc" }],
      ["setup.approvalDelivery.autoResolve", { signingSecret: "abc" }],
      ["setup.approvalDelivery.autoResolve", { deliveryUserId: "xoxb-999" }],
      ["dmAutoroute.list", { orgId: ORG_B }],
      ["setup.slackDmApprovalStatus", { orgId: ORG_B }],
    ] as const) {
      const res = await callAdminMcpTool(tool, args as Record<string, unknown>, cred());
      expect(res.isError).toBe(true);
      expect(["secret_not_accepted", "unexpected_argument"]).toContain(String(data(res).code));
    }
  });

  test("cross-org ids → not found (org from credential only)", async () => {
    const run = data(await callAdminMcpTool("dmAutoroute.run", { employeeId: empB.id }, cred()));
    expect(run.code).toBe("employee_not_found");
    const list = data(await callAdminMcpTool("dmAutoroute.list", { employeeId: empB.id }, cred()));
    expect(list.code).toBe("employee_not_found");
    const orgBInbox = (await listNotificationChannels(ORG_B))[0];
    const resolve = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { inboxId: orgBInbox.id }, cred()));
    expect(resolve.code).toBe("inbox_not_found");
    const all = data(await callAdminMcpTool("dmAutoroute.list", {}, cred()));
    expect(JSON.stringify(all)).not.toContain("DORGBROUTE1");
    expect(JSON.stringify(all)).not.toContain(empB.id);
  });
});

describe("dmAutoroute.run / list", () => {
  test("dryRun (default) is read-only: would_open, no conversations.open, no route, no audit", async () => {
    const auditBefore = getRuntimeAudit().length;
    const routesBefore = (await listSlackImRoutesByOrg(ORG_A)).length;
    const out = data(await callAdminMcpTool("dmAutoroute.run", { employeeId: empA.id }, cred()));
    expect(out.dryRun).toBe(true);
    expect(JSON.stringify(out)).toContain("would_open");
    expect(calls.some((c) => c.method === "conversations.open")).toBe(false);
    expect((await listSlackImRoutesByOrg(ORG_A)).length).toBe(routesBefore);
    expect(getRuntimeAudit().length).toBe(auditBefore);
    noSecrets(out);
  });

  test("dryRun=false queues always_human; route only after approval; list shows auto_party + result", async () => {
    const queued = data(await callAdminMcpTool("dmAutoroute.run", { employeeId: empA.id, dryRun: false }, cred()));
    expect(queued.needs_approval).toBe(true);
    expect(queued.always_human).toBe(true);
    expect(calls.some((c) => c.method === "conversations.open")).toBe(false);
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    const list = data(await callAdminMcpTool("dmAutoroute.list", { employeeId: empA.id }, cred()));
    const routes = list.routes as Array<Record<string, unknown>>;
    expect(routes.some((r) => r.source === "auto_party" && r.counterpartSlackUserId === COLLEAGUE)).toBe(true);
    expect((list.recentResults as Array<Record<string, unknown>>).some((r) => r.outcome === "created")).toBe(true);
    noSecrets(list);
    noSecrets(fulfillment);
  });

  test("dryRun=false with SLACK_DM_AUTOROUTE_ENABLED OFF → error, no ticket", async () => {
    delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
    const res = await callAdminMcpTool("dmAutoroute.run", { employeeId: empA.id, dryRun: false }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("dm_autoroute_flag_off");
  });

  test("ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY=ON: runs without a ticket and leaves an audit row", async () => {
    process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY = "true";
    const out = data(await callAdminMcpTool("dmAutoroute.run", { employeeId: empA.id, dryRun: false }, cred()));
    expect(out.auditOnly).toBe(true);
    expect(out.needs_approval).toBeUndefined();
    expect(
      getRuntimeAudit().some((e) => e.orgId === ORG_A && e.metadata?.event === "admin_mcp.dm_autoroute.run_audit_only")
    ).toBe(true);
    noSecrets(out);
  });

  test("audit-only never applies to an employee bound to this admin agent (no self-escalation)", async () => {
    process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY = "true";
    await linkAgent(empA.id, { orgId: ORG_A, grokBotAgentId: "grok_admin_pr4" });
    const out = data(await callAdminMcpTool("dmAutoroute.run", { employeeId: empA.id, dryRun: false }, cred()));
    expect(out.needs_approval).toBe(true);
    expect(calls.some((c) => c.method === "conversations.open")).toBe(false);
  });
});

describe("setup.approvalDelivery.autoResolve", () => {
  test("always_human even with ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY; nothing sent before approval", async () => {
    process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY = "true";
    await seedInbox(ORG_A, BOT_TOKEN);
    const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", {}, cred()));
    expect(queued.needs_approval).toBe(true);
    expect(queued.always_human).toBe(true);
    expect(calls.some((c) => c.method === "conversations.open" || c.method === "chat.postMessage")).toBe(false);
    noSecrets(queued);
  });

  test("after approval: opens DM, sends one 「設定しました」, saves D… destination, audits", async () => {
    const inbox = await seedInbox(ORG_A, BOT_TOKEN);
    const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { deliveryUserId: APPROVER }, cred()));
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.text).toBe(APPROVAL_SETUP_NOTICE_TEXT);
    const saved = (await listNotificationChannels(ORG_A)).find((c) => c.id === inbox.id)!;
    expect(String(saved.config.channelId)).toMatch(/^D/);
    expect(typeof saved.config.setupNoticeAt).toBe("string");
    expect(saved.config.allowedUserIds).toEqual([APPROVER]);
    expect(getRuntimeAudit().some((e) => e.orgId === ORG_A && e.metadata?.event === "approval_dm.auto_resolved")).toBe(true);
    noSecrets(fulfillment);
    // org B inbox untouched
    expect((await listNotificationChannels(ORG_B))[0].config.channelId).toBe("DORGBDEST01");
  });

  test("approval app lacks users:read → fails closed with missingScope + deep link, destination unchanged", async () => {
    const inbox = await seedInbox(ORG_A, BOT_TOKEN);
    usersInfoMissingScope = true;
    const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", {}, cred()));
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("approval_app_missing_scope");
    expect(String(fulfillment?.nextStepJa)).toContain("users:read");
    expect(String(fulfillment?.nextStepJa)).toContain("https://api.slack.com/apps");
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
    const after = (await listNotificationChannels(ORG_A)).find((c) => c.id === inbox.id)!;
    expect(after.config.channelId).toBe("");
  });

  test("Slack Connect approver → refused, nothing saved", async () => {
    const inbox = await seedInbox(ORG_A, BOT_TOKEN, { allowed: [STRANGER] });
    const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", {}, cred()));
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("approval_user_external");
    expect(calls.some((c) => c.method === "conversations.open")).toBe(false);
    expect((await listNotificationChannels(ORG_A)).find((c) => c.id === inbox.id)!.config.channelId).toBe("");
  });

  test("flag OFF → error, no ticket; delivery user must be in the allowed list", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    const notAllowed = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { deliveryUserId: "UNOTALLOW1" }, cred()));
    expect(notAllowed.code).toBe("delivery_user_not_allowed");
    delete process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
    const off = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", {}, cred()));
    expect(off.code).toBe("approval_dm_auto_open_flag_off");
  });
});
