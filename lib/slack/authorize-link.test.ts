/**
 * B: employee Slack re-authorize link (SLACK_AUTHORIZE_LINK_ENABLED) — demo mode, Slack mocked.
 * Covers: flag OFF fail-closed, always_human issue, delivery only via approval-app DM,
 * no URL / token in MCP results or audit, hash-only storage, single use, 24h expiry,
 * pinned user / team (mismatch → reject, nothing saved), cross-org isolation,
 * new-employee pin from allowedAccounts, approver notification, status next step,
 * optional SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { resolveApproval } from "@/lib/data";
import { linkAgent } from "@/lib/data/bindings";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { resetDemoNotificationChannels, upsertNotificationChannel } from "@/lib/data/notification-channels";
import { getSlackAuthorizeLink, resetDemoSlackAuthorizeLinks } from "@/lib/data/slack-authorize-links";
import {
  bindEmployeeSlackIdentity,
  getEmployeeSlackIdentity,
  getLinkedSlackUserToken,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import {
  ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA,
  ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA,
  ALLOWED_ACCOUNTS_ADD_TOOL,
  ALLOWED_ACCOUNTS_TOOLS_FLAG,
  AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS,
  isAllowedAccountsAdminToolsFlagOn,
  AUTHORIZE_LINK_FOLLOW_UP_STEPS,
  DM_AUTOROUTE_RUN_TOOL,
  SLACK_AUTHORIZE_LINK_PATH,
  resolveAuthorizeLinkFollowUpNextStep,
  authorizeLinkApproverFailureNoticeJa,
  authorizeLinkFailedNoticeJa,
  authorizeLinkPageKind,
  authorizeLinkResultHtml,
  resolveAllowedAccountsSlackNextStep,
  chooseAuthorizeLinkDelivery,
  completeAuthorizeLinkCallback,
  hashAuthorizeLinkToken,
  issueSlackAuthorizeLink,
  resolveApprovalAppBotToken,
  resolveAuthorizeLinkStart,
} from "@/lib/slack/authorize-link";
import { readFileSync } from "node:fs";
import { signSlackOAuthState, verifySlackOAuthState } from "@/lib/slack/oauth";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { DmAutorouteResult } from "@/lib/slack/dm-autoroute";
import type { Employee } from "@/lib/types";

const TOOL = "setup.slackAuthorizeLink.issue";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_authlink_other";
const TEAM = "TAUTHLINK01";
const TEAM_B = "TAUTHLINKB1";
const OLD_USER_TOKEN = "xoxp-authlink-old-SECRET-111";
const NEW_USER_TOKEN = "xoxp-authlink-new-SECRET-222";
const BOT_TOKEN = "xoxb-authlink-approval-SECRET-333";
const BOT_TOKEN_B = "xoxb-authlink-orgb-SECRET-444";
const APPROVER = "UAPPROVER11";
const FLAGS = [
  "SLACK_AUTHORIZE_LINK_ENABLED",
  "SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY",
  "SLACK_USER_SCOPE_IM_WRITE",
  "SLACK_DM_AUTOROUTE_ENABLED",
  "SLACK_APPROVAL_DM_AUTO_OPEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED",
] as const;
// Old token lacks im:write (ともり case).
const OLD_SCOPES = "chat:write,users:read,channels:read,groups:read,im:history,files:write,channels:history,groups:history";

type Call = { method: string; body: Record<string, unknown>; auth: string };
let calls: Call[] = [];
let savedFetch: typeof globalThis.fetch;
let saved: Record<string, string | undefined> = {};
let seq = 0;
let empA: Employee;
let empASlack = "";
let empB: Employee;
/** Per-test Slack overrides (users.info per user; chat.postMessage failure). */
let usersInfoOverride: Record<string, Record<string, unknown>> = {};
let postMessageFails = false;

function cred(orgId = ORG_A, grokBotAgentId = "grok_admin_authlink"): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId, status: "linked" });
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
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    const team = auth.endsWith(BOT_TOKEN_B) ? TEAM_B : TEAM;
    if (method === "auth.test") {
      if (auth.endsWith(OLD_USER_TOKEN)) return json({ ok: true, user_id: empASlack, team_id: TEAM }, { "x-oauth-scopes": OLD_SCOPES });
      return json({ ok: true, user_id: "UBOT", team_id: team, app_id: "AAUTHLINK1" }, { "x-oauth-scopes": "chat:write,im:write,im:read,users:read" });
    }
    if (method === "users.info") return json({ ok: true, user: { id: String(body.user), team_id: team, ...(usersInfoOverride[String(body.user)] ?? {}) } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D${String(body.users).slice(1, 9)}`, is_im: true } });
    if (method === "chat.postMessage") {
      if (postMessageFails) return json({ ok: false, error: "channel_not_found" });
      return json({ ok: true, ts: "1700000000.0002" });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function newEmployee(orgId: string, slackUserIds: string[]): Employee {
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  seq += 1;
  const employee: Employee = {
    ...base,
    id: `emp_authlink_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    displayName: `社員${seq}`,
    allowedAccounts: slackUserIds.map((accountId) => ({ service: "slack", accountId })),
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function noSecrets(value: unknown) {
  const blob = JSON.stringify(value);
  for (const secret of [OLD_USER_TOKEN, NEW_USER_TOKEN, BOT_TOKEN, BOT_TOKEN_B, "SECRET", SLACK_AUTHORIZE_LINK_PATH, "?t="]) {
    expect(blob).not.toContain(secret);
  }
}

/**
 * 追記 4: put the admin tool registry in an explicit state for one test
 * (independent of whether #242 is merged). Restores the exact original state.
 */
function setRegistry(tool: string, want: { name: boolean; def: boolean }): () => void {
  const names = ADMIN_MCP_TOOL_NAMES as unknown as string[];
  const defs = ADMIN_MCP_TOOLS as unknown as Array<Record<string, unknown>>;
  const savedNames = [...names];
  const savedDefs = [...defs];
  const n = names.indexOf(tool);
  if (want.name && n < 0) names.push(tool);
  if (!want.name && n >= 0) names.splice(n, 1);
  const d = defs.findIndex((t) => t.name === tool);
  if (want.def && d < 0) defs.push({ name: tool, description: "mock (always_human)", inputSchema: { type: "object" } });
  if (!want.def && d >= 0) defs.splice(d, 1);
  return () => {
    names.splice(0, names.length, ...savedNames);
    defs.splice(0, defs.length, ...savedDefs);
  };
}
async function withRegistry<T>(tool: string, want: { name: boolean; def: boolean }, run: () => Promise<T>): Promise<T> {
  const restore = setRegistry(tool, want);
  try {
    return await run();
  } finally {
    restore();
  }
}
const PRESENT = { name: true, def: true };
const ABSENT = { name: false, def: false };
function setAllowedAccountsToolsFlag(on: boolean) {
  if (on) process.env.ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED = "true";
  else delete process.env.ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED;
}
function setDmAutorouteFlag(on: boolean) {
  if (on) process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
  else delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
}

async function seedInbox(orgId: string, token: string) {
  return upsertNotificationChannel({
    orgId,
    provider: "slack",
    enabled: true,
    isDefault: true,
    label: `承認 ${orgId}`,
    config: { channelId: "", allowedUserIds: [APPROVER] },
    secrets: { botToken: token, signingSecret: "sig-SECRET" },
  });
}

async function approveAndFulfill(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_authlink" });
  return fulfillApprovedAdmin(approved!);
}

/** The DM text that carried the link → plaintext token (only the approver sees it). */
function deliveredToken(): string {
  const post = calls.filter((c) => c.method === "chat.postMessage").find((c) => String(c.body.text).includes(SLACK_AUTHORIZE_LINK_PATH));
  const match = String(post?.body.text || "").match(/\?t=([A-Za-z0-9_-]{43})/);
  return match ? match[1] : "";
}

async function issueViaTicket(employeeId: string): Promise<string> {
  const queued = data(await callAdminMcpTool(TOOL, { employeeId }, cred()));
  expect(queued.needs_approval).toBe(true);
  const fulfillment = await approveAndFulfill(String(queued.approvalId));
  expect(fulfillment?.ok).toBe(true);
  return deliveredToken();
}

function exchangeWith(token: string) {
  return async () => ({ ok: true, authed_user: { id: "x", access_token: token } });
}
function authTestAs(userId: string, teamId = TEAM) {
  return async () => ({ ok: true, user_id: userId, team_id: teamId, user: "someone" });
}

beforeEach(async () => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
  process.env.SLACK_USER_SCOPE_IM_WRITE = "true";
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret-at-least-32-characters";
  delete process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY;
  delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
  delete process.env.ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED;
  savedFetch = globalThis.fetch;
  usersInfoOverride = {};
  postMessageFails = false;
  installFetch();
  resetDemoNotificationChannels();
  resetDemoSlackAuthorizeLinks();
  empASlack = `UEMPAL${seq + 1}`;
  empA = newEmployee(ORG_A, [empASlack]);
  await bindEmployeeSlackIdentity({ employeeId: empA.id, orgId: ORG_A, slackUserId: empASlack, slackTeamId: TEAM, displayName: "A", userToken: OLD_USER_TOKEN });
  empB = newEmployee(ORG_B, ["UEMPBORG01"]);
  await seedInbox(ORG_A, BOT_TOKEN);
  await seedInbox(ORG_B, BOT_TOKEN_B);
  calls = [];
});

afterEach(async () => {
  // Keep the org's active employee list small (status tool caps at 20).
  for (const employee of getRuntimeEmployees()) {
    if (employee.id.startsWith("emp_authlink_")) employee.status = "suspended";
  }
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId: empA.id, orgId: ORG_A });
});

describe("registry", () => {
  test("admin MCP only, always_human, approvalClass admin, admin.link audit, in every plan", async () => {
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(TOOL)).toBe(true);
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    expect(tool.approvalClass).toBe("admin");
    expect(tool.description).toContain("always_human");
    expect(tool.description.includes("read-only")).toBe(false);
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(TOOL)).toBe(false);
    expect(auditActionForAdminTool(TOOL)).toBe("admin.link");
    for (const plan of Object.values(PLAN_ADMIN_SCOPES)) expect((plan as readonly string[]).includes(TOOL)).toBe(true);
    const employeeNames = [...STAFFPASS_MCP_TOOLS, ...listStaffpassMcpTools()].map((t) => t.name);
    expect(employeeNames.includes(TOOL)).toBe(false);
    const res = await callStaffpassMcpTool(TOOL, { employeeId: empA.id }, { employeeId: empA.id, orgId: ORG_A } as unknown as ResolvedEmployeeCredential);
    expect(data(res).code).toBe("unknown_mcp_tool");
  });
});

describe("flag OFF (default) → fail closed everywhere", () => {
  test("tool, link start and callback link branch all refuse; nothing issued or consumed", async () => {
    const token = await issueViaTicket(empA.id);
    delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    const off = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(off.code).toBe("authorize_link_flag_off");
    expect(off.needs_approval).toBeUndefined();
    expect(await resolveAuthorizeLinkStart(token)).toEqual({ ok: false, code: "authorize_link_flag_off" });
    const start = { orgId: ORG_A, employeeId: empA.id };
    const linkId = String(getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === empA.id)?.metadata?.linkId);
    const cb = await completeAuthorizeLinkCallback({
      state: { ...start, linkId },
      code: "c",
      oauthError: "",
      exchange: exchangeWith(NEW_USER_TOKEN),
      authTest: authTestAs(empASlack),
    });
    expect(cb).toEqual({ ok: false, code: "authorize_link_flag_off", consumed: false });
    expect((await getSlackAuthorizeLink(linkId, ORG_A))?.status).toBe("issued");
    expect(await getLinkedSlackUserToken(empA.id)).toBe(OLD_USER_TOKEN);
  });
});

describe("issue (always_human, delivery only via approval-app DM, no URL returned)", () => {
  test("queues a ticket; nothing sent to Slack before approval; summary names the pins", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(queued.needs_approval).toBe(true);
    expect(queued.always_human).toBe(true);
    expect(String(queued.summary)).toContain(empASlack);
    expect(String(queued.summary)).toContain(APPROVER);
    expect(calls.some((c) => c.method === "chat.postMessage" || c.method === "conversations.open")).toBe(false);
    noSecrets(queued);
  });

  test("deliverTo=approver (explicit): DM to the approver carries the link (unfurl off); result/audit carry only where it went", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id, deliverTo: "approver" }, cred()));
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    noSecrets(fulfillment);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(String(posts[0].body.channel)).toMatch(/^D/);
    expect(posts[0].body.unfurl_links).toBe(false);
    expect(posts[0].body.unfurl_media).toBe(false);
    const token = deliveredToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Re-invoke returns the fulfillment without the URL.
    const reread = data(await callAdminMcpTool(TOOL, { approvalId: String(queued.approvalId) }, cred()));
    noSecrets(reread);
    expect(JSON.stringify(reread)).not.toContain(token);
    expect(fulfillment?.deliveryTarget).toBe("approver");
    expect(fulfillment?.deliveryFallbackReason ?? null).toBeNull();
    expect(String(posts[0].body.text)).not.toContain("社員本人（");
    const issued = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === empA.id)!;
    expect(issued.metadata?.deliveredUserId).toBe(APPROVER);
    expect(issued.metadata?.deliveredTarget).toBe("approver");
    expect(issued.metadata?.deliverToRequested).toBe("approver");
    expect(issued.metadata?.expectedSlackUserId).toBe(empASlack);
    expect(issued.metadata?.expectedTeamId).toBe(TEAM);
    expect(issued.metadata?.auditClass).toBe("admin");
    noSecrets(issued);
    expect(JSON.stringify(issued)).not.toContain(token);
    expect(JSON.stringify(issued)).not.toContain(hashAuthorizeLinkToken(token));
    const link = await getSlackAuthorizeLink(String(issued.metadata?.linkId), ORG_A);
    expect(JSON.stringify(link)).not.toContain(token);
    expect(Date.parse(link!.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(Date.parse(link!.expiresAt) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  });

  test("token-looking args / unknown keys rejected; other org's employee not found", async () => {
    expect(data(await callAdminMcpTool(TOOL, { employeeId: empA.id, url: "x" }, cred())).code).toBe("unexpected_argument");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: empA.id, deliveryUserId: "xoxb-1-SECRET" }, cred())).code).toBe("secret_not_accepted");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: empB.id }, cred(ORG_A))).code).toBe("employee_not_found");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred(ORG_B))).code).toBe("employee_not_found");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: empA.id, deliveryUserId: "UNOTALLOW9" }, cred())).code).toBe("delivery_user_not_allowed");
  });

  test("employee with no identity and no allowed Slack account → refused (allowedAccounts invariant)", async () => {
    const bare = newEmployee(ORG_A, []);
    expect(data(await callAdminMcpTool(TOOL, { employeeId: bare.id }, cred())).code).toBe("slack_account_not_allowed");
  });

  test("re-issue supersedes the previous link", async () => {
    const first = await issueViaTicket(empA.id);
    calls = [];
    const second = await issueViaTicket(empA.id);
    expect(second).not.toBe(first);
    expect((await resolveAuthorizeLinkStart(first)).ok).toBe(false);
    expect((await resolveAuthorizeLinkStart(second)).ok).toBe(true);
  });

  test("pins changed between approval and fulfillment → fail closed, no DM", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    await revokeEmployeeSlackIdentity({ employeeId: empA.id, orgId: ORG_A });
    empA.allowedAccounts = [{ service: "slack", accountId: "UOTHERACC1" }];
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("pins_changed");
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });
});

describe("link start (public, read-only)", () => {
  test("valid → org/employee/team from the stored row; repeated opens do not consume", async () => {
    const token = await issueViaTicket(empA.id);
    const a = await resolveAuthorizeLinkStart(token);
    const b = await resolveAuthorizeLinkStart(token);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok) return;
    expect(a.orgId).toBe(ORG_A);
    expect(a.employeeId).toBe(empA.id);
    expect(a.expectedTeamId).toBe(TEAM);
  });

  test("malformed / unknown / expired tokens → invalid_link", async () => {
    expect(await resolveAuthorizeLinkStart("")).toEqual({ ok: false, code: "invalid_link" });
    expect(await resolveAuthorizeLinkStart("short")).toEqual({ ok: false, code: "invalid_link" });
    expect(await resolveAuthorizeLinkStart("A".repeat(43))).toEqual({ ok: false, code: "invalid_link" });
    const expired = await issueSlackAuthorizeLink({
      orgId: ORG_A,
      employeeId: empA.id,
      approvalId: null,
      via: "ticket",
      now: Date.now() - 25 * 3600_000,
    });
    expect(expired.ok).toBe(true);
    expect((await resolveAuthorizeLinkStart(deliveredToken())).ok).toBe(false);
  });

  test("state carries linkId (signed); tampering is rejected", () => {
    const state = signSlackOAuthState({ orgId: ORG_A, employeeId: empA.id, nonce: "n1", linkId: "link_1" });
    expect(verifySlackOAuthState(state, "n1")?.linkId).toBe("link_1");
    const [encoded, sig] = state.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    payload.linkId = "link_other";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(verifySlackOAuthState(forged, "n1")).toBeNull();
    expect(verifySlackOAuthState(signSlackOAuthState({ orgId: ORG_A, employeeId: empA.id, nonce: "n2" }), "n2")?.linkId).toBeUndefined();
  });
});

async function startState(token: string) {
  const start = await resolveAuthorizeLinkStart(token);
  if (!start.ok) throw new Error("start failed");
  return { orgId: start.orgId, employeeId: start.employeeId, linkId: start.linkId };
}

describe("callback (single use, pinned user / team)", () => {
  test("ともり case: linked employee lacking im:write re-links with the same account; approver notified; single use", async () => {
    const token = await issueViaTicket(empA.id);
    const state = await startState(token);
    calls = [];
    const ok = await completeAuthorizeLinkCallback({ state, code: "code1", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    expect(ok).toEqual({ ok: true, orgId: ORG_A, employeeId: empA.id, slackUserId: empASlack });
    expect(await getLinkedSlackUserToken(empA.id)).toBe(NEW_USER_TOKEN);
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("completed");
    const done = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.completed" && e.metadata?.linkId === state.linkId)!;
    expect(done.metadata?.boundSlackUserId).toBe(empASlack);
    expect(done.metadata?.auditClass).toBe("admin");
    expect(String(done.summary)).toContain(empASlack);
    noSecrets(done);
    const notice = calls.filter((c) => c.method === "chat.postMessage");
    expect(notice).toHaveLength(1);
    expect(String(notice[0].body.text)).toContain(empASlack);
    expect(notice[0].auth).toBe(`Bearer ${BOT_TOKEN}`);
    const again = await completeAuthorizeLinkCallback({ state, code: "code2", oauthError: "", exchange: exchangeWith("xoxp-again-SECRET"), authTest: authTestAs(empASlack) });
    expect(again).toEqual({ ok: false, code: "invalid_link", consumed: false });
    expect(await getLinkedSlackUserToken(empA.id)).toBe(NEW_USER_TOKEN);
    expect((await resolveAuthorizeLinkStart(token)).ok).toBe(false);
  });

  test("different Slack user → rejected, nothing saved, link burned, audit shows the attempt", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UATTACKER1") });
    expect(res).toEqual({ ok: false, code: "user_mismatch", consumed: true });
    expect(await getLinkedSlackUserToken(empA.id)).toBe(OLD_USER_TOKEN);
    expect((await getEmployeeSlackIdentity(empA.id))?.slackUserId).toBe(empASlack);
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("rejected");
    const rejected = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)!;
    expect(rejected.metadata?.attemptedSlackUserId).toBe("UATTACKER1");
    noSecrets(rejected);
    const retry = await completeAuthorizeLinkCallback({ state, code: "c2", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    expect(retry.ok).toBe(false);
  });

  test("different workspace (team) → rejected, nothing saved", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack, "TOTHERWS01") });
    expect(res).toEqual({ ok: false, code: "team_mismatch", consumed: true });
    expect(await getLinkedSlackUserToken(empA.id)).toBe(OLD_USER_TOKEN);
  });

  test("cross-org / cross-employee state never consumes another tenant's link", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    const asOrgB = await completeAuthorizeLinkCallback({ state: { ...state, orgId: ORG_B }, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    expect(asOrgB).toEqual({ ok: false, code: "invalid_link", consumed: false });
    const otherEmp = await completeAuthorizeLinkCallback({ state: { ...state, employeeId: empB.id }, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    expect(otherEmp.ok).toBe(false);
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("issued");
    expect(await getSlackAuthorizeLink(state.linkId, ORG_B)).toBeNull();
  });

  test("user cancels (access_denied) → link stays usable", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    const res = await completeAuthorizeLinkCallback({ state, code: "", oauthError: "access_denied", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    expect(res).toEqual({ ok: false, code: "denied", consumed: false });
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("issued");
  });

  test("bot token returned instead of a user token → rejected", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith("xoxb-not-user-SECRET"), authTest: authTestAs(empASlack) });
    expect(res.ok).toBe(false);
    expect(await getLinkedSlackUserToken(empA.id)).toBe(OLD_USER_TOKEN);
  });

  test("new employee, single allowed account: pinned to it; success binds and surfaces the U…", async () => {
    const fresh = newEmployee(ORG_A, ["UNEWEMP001"]);
    const state = await startState(await issueViaTicket(fresh.id));
    const issued = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === fresh.id)!;
    expect(issued.metadata?.expectedSlackUserId).toBe("UNEWEMP001");
    const wrong = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UAPPROVER11") });
    expect(wrong.ok).toBe(false);
    expect(await getEmployeeSlackIdentity(fresh.id)).toBeNull();
  });

  test("new employee, several allowed accounts: team-only pin; bound U… in change log + approver notice", async () => {
    const fresh = newEmployee(ORG_A, ["UNEWMULTI1", "UNEWMULTI2"]);
    const state = await startState(await issueViaTicket(fresh.id));
    calls = [];
    const ok = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UNEWMULTI2") });
    expect(ok.ok).toBe(true);
    expect((await getEmployeeSlackIdentity(fresh.id))?.slackUserId).toBe("UNEWMULTI2");
    const done = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.completed" && e.metadata?.linkId === state.linkId)!;
    expect(done.metadata?.userPinnedAtIssue).toBe(false);
    expect(done.metadata?.boundSlackUserId).toBe("UNEWMULTI2");
    expect(String(calls.find((c) => c.method === "chat.postMessage")?.body.text)).toContain("UNEWMULTI2");
    await revokeEmployeeSlackIdentity({ employeeId: fresh.id, orgId: ORG_A });
  });

  test("team-only pin still enforces allowedAccounts (account outside the list → rejected)", async () => {
    const fresh = newEmployee(ORG_A, ["UNEWMULTI3", "UNEWMULTI4"]);
    const state = await startState(await issueViaTicket(fresh.id));
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UAPPROVER11") });
    expect(res).toEqual({ ok: false, code: "allowed_accounts_mismatch", consumed: true });
    expect(await getEmployeeSlackIdentity(fresh.id)).toBeNull();
  });
});

describe("setup.slackDmApprovalStatus next step", () => {
  test("flag ON: points at setup.slackAuthorizeLink.issue; OFF: unchanged tap text", async () => {
    // The status tool lists at most 20 active employees: keep empA in the window
    // regardless of what other test files left in the shared demo store.
    const others = getRuntimeEmployees().filter((e) => e.orgId === ORG_A && e.id !== empA.id && e.status === "active");
    for (const e of others) e.status = "suspended";
    try {
      await statusChecks();
    } finally {
      for (const e of others) e.status = "active";
    }
  });
});

async function statusChecks() {
  {
    const on = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    const steps = (on.nextStepsJa as string[]).join("\n");
    expect(steps).toContain(`setup.slackAuthorizeLink.issue（employeeId=${empA.id}）`);
    expect((on.flags as Record<string, boolean>).SLACK_AUTHORIZE_LINK_ENABLED).toBe(true);
    delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    const off = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    const offSteps = (off.nextStepsJa as string[]).join("\n");
    expect(offSteps.includes("setup.slackAuthorizeLink.issue")).toBe(false);
    expect(offSteps).toContain("もう一度 Slack 連携をタップ");
  }
}

describe("SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY (default OFF, 要判断)", () => {
  test("ON: linked employee lacking exactly im:write → issued without a ticket, audited", async () => {
    process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY = "true";
    const out = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(out.needs_approval).toBeUndefined();
    expect(out.auditOnly).toBe(true);
    expect(out.urlReturned).toBe(false);
    noSecrets(out);
    const issued = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === empA.id)!;
    expect(issued.metadata?.issuedVia).toBe("audit_only");
    expect(deliveredToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("ON but employee bound to this admin agent → still a human ticket", async () => {
    process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY = "true";
    const c = cred();
    await linkAgent(empA.id, { orgId: ORG_A, grokBotAgentId: String(c.grokBotAgentId) });
    const out = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, c));
    expect(out.needs_approval).toBe(true);
  });

  test("ON but employee not linked (new) → still a human ticket", async () => {
    process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY = "true";
    const fresh = newEmployee(ORG_A, ["UNEWEMP009"]);
    const out = data(await callAdminMcpTool(TOOL, { employeeId: fresh.id }, cred()));
    expect(out.needs_approval).toBe(true);
  });

  test("OFF (default) → ticket even for the im:write-only case", async () => {
    const out = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(out.needs_approval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 追加（2026-10-04 木村指示）: deliverTo / allowedAccounts next step / failure notices
// ---------------------------------------------------------------------------

function posts() {
  return calls.filter((c) => c.method === "chat.postMessage");
}
function dmChannelFor(userId: string): string {
  return `D${userId.slice(1, 9)}`;
}
function issuedAudit(employeeId: string) {
  return getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === employeeId)!;
}

describe("deliverTo (default employee)", () => {
  test("default → link DM to the pinned employee U… via the approval-app bot; approver gets 「社員本人に送りました」 (no URL)", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(queued.needs_approval).toBe(true);
    expect(String(queued.summary)).toContain("社員本人");
    expect(String(queued.summary)).toContain(empASlack);
    noSecrets(queued);
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.deliveryTarget).toBe("employee");
    expect(fulfillment?.deliveryFallbackReason ?? null).toBeNull();
    noSecrets(fulfillment);
    const opened = calls.filter((c) => c.method === "conversations.open").map((c) => String(c.body.users));
    expect(opened).toContain(empASlack);
    expect(opened).toContain(APPROVER);
    const sent = posts();
    expect(sent).toHaveLength(2);
    for (const post of sent) expect(post.auth).toBe(`Bearer ${BOT_TOKEN}`);
    const linkPost = sent.find((c) => String(c.body.text).includes(SLACK_AUTHORIZE_LINK_PATH))!;
    expect(linkPost.body.channel).toBe(dmChannelFor(empASlack));
    expect(linkPost.body.unfurl_links).toBe(false);
    const notice = sent.find((c) => c !== linkPost)!;
    expect(notice.body.channel).toBe(dmChannelFor(APPROVER));
    expect(String(notice.body.text)).toContain(`社員本人（<@${empASlack}>）に再認可リンクを送りました`);
    expect(String(notice.body.text)).not.toContain(SLACK_AUTHORIZE_LINK_PATH);
    expect(String(notice.body.text)).not.toContain("?t=");
    const issued = issuedAudit(empA.id);
    expect(issued.metadata?.deliveredTarget).toBe("employee");
    expect(issued.metadata?.deliveredUserId).toBe(empASlack);
    expect(issued.metadata?.approverUserId).toBe(APPROVER);
    expect(issued.metadata?.deliverToRequested).toBe("employee");
    expect(issued.metadata?.deliverToExplicit).toBe(false);
    expect(issued.metadata?.deliveryFallbackReason ?? null).toBeNull();
    expect(issued.metadata?.approverNoticeSent).toBe(true);
    noSecrets(issued);
    const link = await getSlackAuthorizeLink(String(issued.metadata?.linkId), ORG_A);
    expect(link?.deliveredTarget).toBe("employee");
    expect(link?.deliveredUserId).toBe(empASlack);
    expect(link?.approverUserId).toBe(APPROVER);
    const reread = data(await callAdminMcpTool(TOOL, { approvalId: String(queued.approvalId) }, cred()));
    noSecrets(reread);
    expect(JSON.stringify(reread)).not.toContain(deliveredToken());
  });

  test("direct issue result (no URL) records target + approver", async () => {
    const res = await issueSlackAuthorizeLink({ orgId: ORG_A, employeeId: empA.id, approvalId: null, via: "ticket" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deliveredTo.target).toBe("employee");
    expect(res.deliveredTo.deliveryUserId).toBe(empASlack);
    expect(res.deliveredTo.approverUserId).toBe(APPROVER);
    expect(res.deliveredTo.fallbackReason).toBeNull();
    expect(JSON.stringify(res)).not.toContain(deliveredToken());
    noSecrets(res);
  });

  test("several allowed Slack accounts (U… not unique), default → approver, reason recorded", async () => {
    const fresh = newEmployee(ORG_A, ["UMULTIDLV1", "UMULTIDLV2"]);
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: fresh.id }, cred()));
    expect(String(queued.summary)).toContain("employee_slack_user_ambiguous");
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.deliveryTarget).toBe("approver");
    expect(fulfillment?.deliveryFallbackReason).toBe("employee_slack_user_ambiguous");
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.channel).toBe(dmChannelFor(APPROVER));
    expect(calls.some((c) => c.method === "conversations.open" && String(c.body.users).startsWith("UMULTIDLV"))).toBe(false);
    const issued = issuedAudit(fresh.id);
    expect(issued.metadata?.deliveredTarget).toBe("approver");
    expect(issued.metadata?.deliveryFallbackReason).toBe("employee_slack_user_ambiguous");
    expect(issued.metadata?.deliverToExplicit).toBe(false);
  });

  test("explicit deliverTo=employee but U… not unique → approver, reason recorded as explicit", async () => {
    const fresh = newEmployee(ORG_A, ["UMULTIDLV3", "UMULTIDLV4"]);
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: fresh.id, deliverTo: "employee" }, cred()));
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.deliveryTarget).toBe("approver");
    expect(fulfillment?.deliveryFallbackReason).toBe("employee_slack_user_ambiguous");
    const issued = issuedAudit(fresh.id);
    expect(issued.metadata?.deliverToRequested).toBe("employee");
    expect(issued.metadata?.deliverToExplicit).toBe(true);
    expect(issued.metadata?.deliveryFallbackReason).toBe("employee_slack_user_ambiguous");
  });

  test("employee DM cannot be opened (e.g. guest) → approver, reason recorded", async () => {
    usersInfoOverride[empASlack] = { is_restricted: true };
    const res = await issueSlackAuthorizeLink({ orgId: ORG_A, employeeId: empA.id, approvalId: null, via: "ticket" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deliveredTo.target).toBe("approver");
    expect(res.deliveredTo.deliveryUserId).toBe(APPROVER);
    expect(res.deliveredTo.fallbackReason).toBe("employee_dm_unavailable");
    expect(issuedAudit(empA.id).metadata?.employeeDmError).toBe("approval_user_guest");
  });

  test("chooseAuthorizeLinkDelivery: zero / many / one candidates; explicit approver", () => {
    expect(chooseAuthorizeLinkDelivery({ employeeSlackUserIds: [] })).toEqual({
      target: "approver", employeeUserId: null, requested: "employee", explicit: false, fallbackReason: "employee_slack_user_missing",
    });
    expect(chooseAuthorizeLinkDelivery({ requested: "employee", employeeSlackUserIds: ["UA1", "UB2"] }).fallbackReason).toBe("employee_slack_user_ambiguous");
    expect(chooseAuthorizeLinkDelivery({ employeeSlackUserIds: ["UONE111"] })).toEqual({
      target: "employee", employeeUserId: "UONE111", requested: "employee", explicit: false, fallbackReason: null,
    });
    expect(chooseAuthorizeLinkDelivery({ requested: "approver", employeeSlackUserIds: ["UONE111"] })).toEqual({
      target: "approver", employeeUserId: null, requested: "approver", explicit: true, fallbackReason: null,
    });
  });

  test("invalid deliverTo value → rejected before queueing", async () => {
    const res = data(await callAdminMcpTool(TOOL, { employeeId: empA.id, deliverTo: "channel" }, cred()));
    expect(res.code).toBe("invalid_deliver_to");
    expect(res.needs_approval).toBeUndefined();
  });

  test("schema exposes deliverTo enum (employee default, approver)", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.deliverTo?.enum).toEqual(["employee", "approver"]);
  });
});

describe("approval-app bot token resolution (single function)", () => {
  test("resolveApprovalAppBotToken: org-scoped inbox token; other org / unknown inbox → empty", async () => {
    const inboxA = (await upsertNotificationChannel({
      orgId: ORG_A, provider: "slack", enabled: true, isDefault: false, label: "tok A",
      config: { channelId: "", allowedUserIds: [APPROVER] }, secrets: { botToken: BOT_TOKEN, signingSecret: "s-SECRET" },
    })) as { id: string };
    expect(await resolveApprovalAppBotToken(ORG_A, inboxA.id)).toBe(BOT_TOKEN);
    expect(await resolveApprovalAppBotToken(ORG_B, inboxA.id)).toBe("");
    expect(await resolveApprovalAppBotToken(ORG_A, "")).toBe("");
    expect(await resolveApprovalAppBotToken(ORG_A, "nbx_missing")).toBe("");
  });

  test("source guard: notification-channel secrets are read only inside resolveApprovalAppBotToken", () => {
    const src = readFileSync(new URL("./authorize-link.ts", import.meta.url), "utf8");
    const reads = src.match(/getNotificationChannelSecretsById\(/g) ?? [];
    expect(reads).toHaveLength(1);
    const fn = src.slice(src.indexOf("export async function resolveApprovalAppBotToken"));
    expect(fn.slice(0, 600)).toContain("getNotificationChannelSecretsById(");
  });

  test("employee link DM, approver notice and completion notice all use the same approval-app token", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(empASlack) });
    const sent = posts();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const post of sent) expect(post.auth).toBe(`Bearer ${BOT_TOKEN}`);
  });
});

describe("allowedAccounts without Slack → next step guidance", () => {
  test("issue error names the real next step (no invented admin MCP tool)", async () => {
    setAllowedAccountsToolsFlag(false);
    const restore = setRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, ABSENT);
    try {
      await issueErrorChecks();
    } finally {
      restore();
    }
  });
  async function issueErrorChecks() {
    const bare = newEmployee(ORG_A, []);
    const res = data(await callAdminMcpTool(TOOL, { employeeId: bare.id }, cred()));
    expect(res.code).toBe("slack_account_not_allowed");
    expect(String(res.message)).toContain(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA);
    expect(res.nextStepJa).toBe(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA);
    expect(res.allowedAccountsAdminTool ?? null).toBeNull();
    // Every dotted tool-like name in the guidance must be a real admin MCP tool.
    const names = ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA.match(/\b[a-z][A-Za-z]*\.[a-z][A-Za-z.]*\b/g) ?? [];
    for (const name of names) expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
    expect(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA).toContain("ブラウザ・外部アカウント");
  }

  test("setup.slackDmApprovalStatus shows the same guidance for that employee (flag ON)", async () => {
    setAllowedAccountsToolsFlag(false);
    const restore = setRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, ABSENT);
    const bare = newEmployee(ORG_A, []);
    const others = getRuntimeEmployees().filter((e) => e.orgId === ORG_A && e.id !== bare.id && e.status === "active");
    for (const e of others) e.status = "suspended";
    try {
      const on = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
      const steps = (on.nextStepsJa as string[]).join("\n");
      expect(steps).toContain(`${bare.displayName}: `);
      expect(steps).toContain(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA);
      expect(steps.includes(`setup.slackAuthorizeLink.issue（employeeId=${bare.id}）`)).toBe(false);
      const row = (on.employees as Array<Record<string, unknown>>).find((r) => r.employeeId === bare.id)!;
      expect(row.allowedSlackAccounts).toBe(0);
    } finally {
      for (const e of others) e.status = "active";
      restore();
    }
  });
});

describe("failure notices (user_mismatch / exchange failure)", () => {
  test("user_mismatch (employee delivery) → notice to the employee DM without the other U…; link stays used", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    calls = [];
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UATTACKER1") });
    expect(res).toEqual({ ok: false, code: "user_mismatch", consumed: true });
    const sent = posts();
    expect(sent).toHaveLength(2);
    const toEmployee = sent.find((c) => c.body.channel === dmChannelFor(empASlack))!;
    expect(toEmployee.auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(String(toEmployee.body.text)).toContain(authorizeLinkFailedNoticeJa("user_mismatch"));
    for (const post of sent) expect(String(post.body.text)).not.toContain("UATTACKER1");
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("rejected");
    const rejected = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)!;
    expect(rejected.metadata?.failureNoticeSent).toBe(true);
    expect(rejected.metadata?.failureNoticeTarget).toBe("employee");
    expect(rejected.metadata?.approverFailureNoticeSent).toBe(true);
  });

  test("exchange failure (approver delivery) → notice to the approver DM", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id, deliverTo: "approver" }, cred()));
    await approveAndFulfill(String(queued.approvalId));
    const state = await startState(deliveredToken());
    calls = [];
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: async () => ({ ok: false }), authTest: authTestAs(empASlack) });
    expect(res).toEqual({ ok: false, code: "oauth_exchange_failed", consumed: true });
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.channel).toBe(dmChannelFor(APPROVER));
    expect(String(sent[0].body.text)).toContain(authorizeLinkFailedNoticeJa("oauth_exchange_failed"));
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("rejected");
    // Delivered to the approver → no second (approver) notice.
    const rejected = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)!;
    expect(rejected.metadata?.failureNoticeTarget).toBe("approver");
    expect(rejected.metadata?.approverFailureNoticeSent).toBe(false);
    expect(rejected.metadata?.approverFailureNoticeSkipped).toBe("delivered_to_approver");
  });

  test("exchange throws → same notice; notice send failure never breaks the callback", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    calls = [];
    postMessageFails = true;
    const res = await completeAuthorizeLinkCallback({
      state, code: "c", oauthError: "",
      exchange: async () => { throw new Error("boom"); },
      authTest: authTestAs(empASlack),
    });
    expect(res).toEqual({ ok: false, code: "oauth_exchange_failed", consumed: true });
    const rejected = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)!;
    expect(rejected.metadata?.failureNoticeSent).toBe(false);
  });

  test("notice token lookup throwing never breaks the callback", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs("UATTACKER2") });
    expect(res).toEqual({ ok: false, code: "user_mismatch", consumed: true });
  });

  test("one template, only the reason code varies (notice + page)", () => {
    expect(authorizeLinkFailedNoticeJa("user_mismatch")).toBe(
      "再認可リンクが別のアカウントで開かれた（または認可に失敗した）ため無効になりました（user_mismatch）。管理者に再発行を依頼してください。"
    );
    expect(authorizeLinkApproverFailureNoticeJa("社員X", "team_mismatch")).toBe(
      "社員「社員X」の再認可リンクが失敗しました（team_mismatch）。再発行してください"
    );
    const html = authorizeLinkResultHtml("burned", "team_mismatch");
    expect(html).toContain(authorizeLinkFailedNoticeJa("team_mismatch"));
    // Untrusted / odd code never reaches the page or DM verbatim.
    expect(authorizeLinkFailedNoticeJa("<script>")).toContain("（unknown）");
    expect(authorizeLinkResultHtml("burned", "<b>x</b>")).not.toContain("<b>");
  });
});

describe("audit_only path keeps its gate; delivery follows deliverTo", () => {
  test("ON: im:write-only re-issue without ticket delivers to the employee and records it (no URL)", async () => {
    process.env.SLACK_AUTHORIZE_LINK_REISSUE_AUDIT_ONLY = "true";
    const out = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
    expect(out.auditOnly).toBe(true);
    expect(out.deliveryTarget).toBe("employee");
    expect((out.deliveredTo as Record<string, unknown>).target).toBe("employee");
    expect(out.urlReturned).toBe(false);
    noSecrets(out);
    expect(issuedAudit(empA.id).metadata?.issuedVia).toBe("audit_only");
  });
});

// ---------------------------------------------------------------------------
// 追加 2（2026-10-04 木村回答）: 使用済み理由すべてに失敗通知 / 承認者通知 / registry 連動の次の手順
// ---------------------------------------------------------------------------

const ATTACKER = "UOUTSIDER9";

type ReasonCase = {
  code: string;
  /** Builds the scenario; returns callback inputs and whether delivery went to the employee. */
  run: () => Promise<{ state: { orgId: string; employeeId: string; linkId: string }; viaEmployee: boolean; employeeName: string; cleanup?: () => void; input: Partial<Parameters<typeof completeAuthorizeLinkCallback>[0]> }>;
};

async function employeeLinkState() {
  const state = await startState(await issueViaTicket(empA.id));
  return { state, viaEmployee: true, employeeName: empA.displayName };
}

const REASON_CASES: ReasonCase[] = [
  { code: "oauth_exchange_failed", run: async () => ({ ...(await employeeLinkState()), input: { exchange: async () => ({ ok: false }) } }) },
  { code: "user_token_missing", run: async () => ({ ...(await employeeLinkState()), input: { exchange: exchangeWith("xoxb-not-user-SECRET") } }) },
  { code: "auth_test_failed", run: async () => ({ ...(await employeeLinkState()), input: { authTest: async () => ({ ok: false }) } }) },
  { code: "team_mismatch", run: async () => ({ ...(await employeeLinkState()), input: { authTest: authTestAs(ATTACKER, "TOTHERWS01") } }) },
  { code: "user_mismatch", run: async () => ({ ...(await employeeLinkState()), input: { authTest: authTestAs(ATTACKER) } }) },
  {
    code: "allowed_accounts_mismatch",
    run: async () => {
      // Several allowed accounts → team-only pin → approver delivery (ambiguous).
      const fresh = newEmployee(ORG_A, ["UAAMULTI01", "UAAMULTI02"]);
      const state = await startState(await issueViaTicket(fresh.id));
      return { state, viaEmployee: false, employeeName: fresh.displayName, input: { authTest: authTestAs(ATTACKER) } };
    },
  },
  {
    code: "bind_failed",
    run: async () => {
      const base = await employeeLinkState();
      // Employee row disappears between link start and bind → bind throws (not a mismatch).
      const list = getRuntimeEmployees();
      const index = list.findIndex((e) => e.id === empA.id);
      const [removed] = list.splice(index, 1);
      return { ...base, cleanup: () => list.push(removed), input: {} };
    },
  },
];

describe("every consumed-failure reason: recipient notice + approver notice + page (one template)", () => {
  test("reason list covers every reject() path in the callback", () => {
    expect([...AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS].sort()).toEqual(REASON_CASES.map((c) => c.code).sort());
    // Scan only the callback (post-consume) body: every reject("…") code, incl. the bind ternary.
    const full = readFileSync(new URL("./authorize-link.ts", import.meta.url), "utf8");
    const start = full.indexOf("export async function completeAuthorizeLinkCallback");
    const src = full.slice(start, full.indexOf("\n}\n", start));
    const used = new Set([
      ...[...src.matchAll(/reject\("([a-z0-9_]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/return reject\([^,)]*\? "([a-z0-9_]+)" : "([a-z0-9_]+)"/g)].flatMap((m) => [m[1], m[2]]),
    ]);
    expect([...used].sort()).toEqual([...AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS].sort());
  });

  for (const reason of REASON_CASES) {
    test(`${reason.code}: link burned; recipient + (employee delivery only) approver notified; no other U…; page same template`, async () => {
      const scenario = await reason.run();
      calls = [];
      try {
        const res = await completeAuthorizeLinkCallback({
          state: scenario.state,
          code: "c",
          oauthError: "",
          exchange: exchangeWith(NEW_USER_TOKEN),
          authTest: authTestAs(empASlack),
          ...scenario.input,
        });
        expect(res).toEqual({ ok: false, code: reason.code, consumed: true });
        expect((await getSlackAuthorizeLink(scenario.state.linkId, ORG_A))?.status).toBe("rejected");
        const sent = posts();
        for (const post of sent) {
          expect(post.auth).toBe(`Bearer ${BOT_TOKEN}`);
          expect(String(post.body.text)).not.toContain(ATTACKER);
          expect(String(post.body.text)).not.toContain(SLACK_AUTHORIZE_LINK_PATH);
          expect(String(post.body.text)).not.toContain("?t=");
        }
        const approverPosts = sent.filter((c) => c.body.channel === dmChannelFor(APPROVER));
        if (scenario.viaEmployee) {
          expect(sent).toHaveLength(2);
          const toEmployee = sent.find((c) => c.body.channel === dmChannelFor(empASlack))!;
          expect(String(toEmployee.body.text)).toContain(authorizeLinkFailedNoticeJa(reason.code));
          expect(approverPosts).toHaveLength(1);
          expect(String(approverPosts[0].body.text)).toContain(
            authorizeLinkApproverFailureNoticeJa(reason.code === "bind_failed" ? empA.id : scenario.employeeName, reason.code)
          );
        } else {
          // Delivered to the approver: exactly one notice (no duplicate).
          expect(sent).toHaveLength(1);
          expect(approverPosts).toHaveLength(1);
          expect(String(approverPosts[0].body.text)).toContain(authorizeLinkFailedNoticeJa(reason.code));
        }
        const rejected = getRuntimeAudit().find(
          (e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === scenario.state.linkId
        )!;
        expect(rejected.metadata?.reason).toBe(reason.code);
        expect(rejected.metadata?.failureNoticeSent).toBe(true);
        expect(rejected.metadata?.approverFailureNoticeSent).toBe(scenario.viaEmployee);
        noSecrets(rejected);
        const kind = authorizeLinkPageKind(reason.code);
        expect(kind).toBe("burned");
        const html = authorizeLinkResultHtml(kind, reason.code);
        expect(html).toContain(authorizeLinkFailedNoticeJa(reason.code));
        expect(html).not.toContain(ATTACKER);
      } finally {
        scenario.cleanup?.();
      }
    });
  }

  test("(d) audit keeps attemptedSlackUserId for takeover investigation; notices and page never show it", async () => {
    for (const code of ["user_mismatch", "allowed_accounts_mismatch"]) {
      const scenario = await REASON_CASES.find((c) => c.code === code)!.run();
      calls = [];
      await completeAuthorizeLinkCallback({
        state: scenario.state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(ATTACKER),
      });
      const rejected = getRuntimeAudit().find(
        (e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === scenario.state.linkId
      )!;
      expect(rejected.metadata?.attemptedSlackUserId).toBe(ATTACKER);
      expect(JSON.stringify(posts())).not.toContain(ATTACKER);
      expect(authorizeLinkResultHtml(authorizeLinkPageKind(code), code)).not.toContain(ATTACKER);
    }
  });

  test("approver notice failure never breaks the callback; recorded as not sent", async () => {
    const state = await startState(await issueViaTicket(empA.id));
    postMessageFails = true;
    const res = await completeAuthorizeLinkCallback({ state, code: "c", oauthError: "", exchange: exchangeWith(NEW_USER_TOKEN), authTest: authTestAs(ATTACKER, "TOTHERWS01") });
    expect(res).toEqual({ ok: false, code: "team_mismatch", consumed: true });
    const rejected = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)!;
    expect(rejected.metadata?.approverFailureNoticeSent).toBe(false);
  });

  test("non-consumed outcomes are not failure-burned (denied / invalid)", () => {
    expect(authorizeLinkPageKind("denied")).toBe("denied");
    expect(authorizeLinkPageKind("invalid_link")).toBe("invalid");
    expect(authorizeLinkPageKind("authorize_link_flag_off")).toBe("invalid");
  });
});

describe("allowedAccounts next step: registry × ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED (追記 4)", () => {
  const DASHBOARD = { nextStepJa: ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA, allowedAccountsAdminTool: null };
  const TOOL_STEP = { nextStepJa: ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA, allowedAccountsAdminTool: ALLOWED_ACCOUNTS_ADD_TOOL };
  async function issueRefusal() {
    const bare = newEmployee(ORG_A, []);
    const res = data(await callAdminMcpTool(TOOL, { employeeId: bare.id }, cred()));
    expect(res.code).toBe("slack_account_not_allowed");
    return res;
  }

  test("tool present × flag ON → points at employees.allowedAccounts.add; tool name returned", async () => {
    setAllowedAccountsToolsFlag(true);
    await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, PRESENT, async () => {
      const step = await resolveAllowedAccountsSlackNextStep();
      expect(step).toEqual(TOOL_STEP);
      expect(step.nextStepJa).toContain(`${ALLOWED_ACCOUNTS_ADD_TOOL} で Slack の U… を追加してから`);
      const res = await issueRefusal();
      expect(res.allowedAccountsAdminTool).toBe(ALLOWED_ACCOUNTS_ADD_TOOL);
      expect(res.nextStepJa).toBe(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA);
      expect(String(res.message)).toContain(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA);
      // Every dotted tool-like name in the guidance is registered.
      const names = step.nextStepJa.match(/\b[a-z][A-Za-z]*\.[a-z][A-Za-z.]*\b/g) ?? [];
      for (const name of names) expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
    });
  });

  test("tool present × flag OFF → dashboard guidance, allowedAccountsAdminTool null", async () => {
    setAllowedAccountsToolsFlag(false);
    await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, PRESENT, async () => {
      expect(await resolveAllowedAccountsSlackNextStep()).toEqual(DASHBOARD);
      const res = await issueRefusal();
      expect(res.nextStepJa).toBe(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA);
      expect(res.allowedAccountsAdminTool).toBeNull();
      expect(String(res.message).includes(ALLOWED_ACCOUNTS_ADD_TOOL)).toBe(false);
    });
  });

  test("tool absent × flag ON → dashboard guidance, allowedAccountsAdminTool null", async () => {
    setAllowedAccountsToolsFlag(true);
    await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, ABSENT, async () => {
      expect(await resolveAllowedAccountsSlackNextStep()).toEqual(DASHBOARD);
      const res = await issueRefusal();
      expect(res.allowedAccountsAdminTool).toBeNull();
      expect(String(res.message).includes(ALLOWED_ACCOUNTS_ADD_TOOL)).toBe(false);
    });
  });

  test("tool absent × flag OFF → dashboard guidance, allowedAccountsAdminTool null", async () => {
    setAllowedAccountsToolsFlag(false);
    await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, ABSENT, async () => {
      expect(await resolveAllowedAccountsSlackNextStep()).toEqual(DASHBOARD);
      expect((await issueRefusal()).allowedAccountsAdminTool).toBeNull();
    });
  });

  test("flag ON but only the name or only the definition → still dashboard guidance", async () => {
    setAllowedAccountsToolsFlag(true);
    for (const want of [{ name: true, def: false }, { name: false, def: true }]) {
      await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, want, async () => {
        expect(await resolveAllowedAccountsSlackNextStep()).toEqual(DASHBOARD);
      });
    }
  });

  test("flag parsing matches #242 (trim + lowercase; true / 1 / on / enabled)", async () => {
    expect(ALLOWED_ACCOUNTS_TOOLS_FLAG).toBe("ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED");
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false], ["", false], ["true", true], [" TRUE ", true], ["1", true], ["on", true], ["On", true],
      ["enabled", true], ["false", false], ["0", false], ["off", false], ["yes", false], ["truthy", false],
    ];
    // #242 present (merged) → compare with its own parser; absent → just the table.
    const modulePath = "@/lib/admin-mcp/allowed-accounts-tools";
    const theirs = await import(modulePath)
      .then((m: Record<string, unknown>) =>
        typeof m.isEmployeesAllowedAccountsAdminToolAvailable === "function"
          ? (m.isEmployeesAllowedAccountsAdminToolAvailable as () => boolean)
          : null
      )
      .catch(() => null);
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED;
      else process.env.ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED = value;
      expect(isAllowedAccountsAdminToolsFlagOn()).toBe(expected);
      if (theirs) expect(theirs()).toBe(expected);
    }
  });

  test("source guard: #240 does not import #242's module statically", () => {
    for (const file of ["./authorize-link.ts", "./authorize-link-guidance.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src.includes("allowed-accounts-tools")).toBe(false);
    }
  });

  test("setup.slackDmApprovalStatus uses the same resolver (present × ON vs present × OFF)", async () => {
    const bare = newEmployee(ORG_A, []);
    const others = getRuntimeEmployees().filter((e) => e.orgId === ORG_A && e.id !== bare.id && e.status === "active");
    for (const e of others) e.status = "suspended";
    try {
      await withRegistry(ALLOWED_ACCOUNTS_ADD_TOOL, PRESENT, async () => {
        setAllowedAccountsToolsFlag(false);
        const off = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
        expect((off.nextStepsJa as string[]).join("\n")).toContain(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA);
        expect((off.employees as Array<Record<string, unknown>>).find((r) => r.employeeId === bare.id)!.allowedAccountsAdminTool).toBeNull();
        setAllowedAccountsToolsFlag(true);
        const on = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
        const steps = (on.nextStepsJa as string[]).join("\n");
        expect(steps).toContain(`${bare.displayName}: `);
        expect(steps).toContain(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA);
        expect(steps.includes(ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA)).toBe(false);
        const row = (on.employees as Array<Record<string, unknown>>).find((r) => r.employeeId === bare.id)!;
        expect(row.allowedAccountsAdminTool).toBe(ALLOWED_ACCOUNTS_ADD_TOOL);
      });
    } finally {
      for (const e of others) e.status = "active";
    }
  });
});

describe("追記 3: post-bind follow-ups (dmAutoroute + completion notice) are independent", () => {
  type DmInput = { orgId: string; employeeId: string; trigger: string };
  function dmSpy(impl: () => Promise<DmAutorouteResult>) {
    const seen: DmInput[] = [];
    const fn = async (input: DmInput) => {
      seen.push(input);
      return impl();
    };
    return { seen, fn };
  }
  const ok = async (): Promise<DmAutorouteResult> => ({ status: "done", items: [] });
  function events(linkId: string, name: string) {
    return getRuntimeAudit().filter((e) => e.metadata?.event === name && e.metadata?.linkId === linkId);
  }
  async function linkWith(
    dm: (input: DmInput) => Promise<DmAutorouteResult>,
    opts: { failNotice?: boolean; defer?: (job: () => Promise<void>) => void } = {}
  ) {
    const state = await startState(await issueViaTicket(empA.id));
    calls = [];
    postMessageFails = Boolean(opts.failNotice);
    const result = await completeAuthorizeLinkCallback({
      state,
      code: "c",
      oauthError: "",
      exchange: exchangeWith(NEW_USER_TOKEN),
      authTest: authTestAs(empASlack),
      followUpDeps: { dmAutoroute: dm as never },
      ...(opts.defer ? { deferFollowUps: opts.defer } : {}),
    });
    postMessageFails = false;
    return { state, result };
  }
  function expectCleanErrorsAudit(row: { metadata?: Record<string, unknown>; summary?: string }) {
    noSecrets(row);
    const blob = JSON.stringify(row);
    // Only step names + reason codes: no U… (not even the bound one), no URL.
    expect(blob.includes(empASlack)).toBe(false);
    expect(blob.includes(APPROVER)).toBe(false);
    expect(blob.includes("https://")).toBe(false);
  }

  test("registry: dmAutoroute.run is a real admin MCP tool (name + definition)", () => {
    expect(DM_AUTOROUTE_RUN_TOOL).toBe("dmAutoroute.run");
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(DM_AUTOROUTE_RUN_TOOL)).toBe(true);
    expect(ADMIN_MCP_TOOLS.some((t) => t.name === DM_AUTOROUTE_RUN_TOOL)).toBe(true);
    expect([...AUTHORIZE_LINK_FOLLOW_UP_STEPS]).toEqual(["link_status", "completed_audit", "completion_notice", "dm_autoroute"]);
  });

  test("all succeed → only completed is recorded; both follow-ups ran", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const dm = dmSpy(ok);
    const { state, result } = await linkWith(dm.fn);
    expect(result.ok).toBe(true);
    expect(dm.seen).toEqual([{ orgId: ORG_A, employeeId: empA.id, trigger: "identity_linked" }]);
    expect(posts().some((c) => String(c.body.text).includes("Slack 連携が完了しました"))).toBe(true);
    expect(events(state.linkId, "slack_authorize_link.completed")).toHaveLength(1);
    expect(events(state.linkId, "slack_authorize_link.completed_with_errors")).toHaveLength(0);
  });

  test("dmAutoroute flag OFF → not run, not an error (completed only)", async () => {
    const dm = dmSpy(ok);
    const { state } = await linkWith(dm.fn);
    expect(dm.seen).toHaveLength(0);
    expect(events(state.linkId, "slack_authorize_link.completed_with_errors")).toHaveLength(0);
  });

  test("completion notice fails → dmAutoroute still runs; completed_with_errors + nextStep; page/result still success; no failure notice", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const dm = dmSpy(ok);
    const { state, result } = await linkWith(dm.fn, { failNotice: true });
    expect(result).toEqual({ ok: true, orgId: ORG_A, employeeId: empA.id, slackUserId: empASlack });
    expect(dm.seen).toHaveLength(1);
    expect((await getSlackAuthorizeLink(state.linkId, ORG_A))?.status).toBe("completed");
    expect(await getLinkedSlackUserToken(empA.id)).toBe(NEW_USER_TOKEN);
    expect(events(state.linkId, "slack_authorize_link.completed")).toHaveLength(1);
    const errs = events(state.linkId, "slack_authorize_link.completed_with_errors");
    expect(errs).toHaveLength(1);
    expect(errs[0].metadata?.failedSteps).toEqual([{ step: "completion_notice", code: "channel_not_found" }]);
    expect(errs[0].metadata?.recoveryAdminTool).toBe(DM_AUTOROUTE_RUN_TOOL);
    expect(String(errs[0].metadata?.nextStepJa)).toContain(`${DM_AUTOROUTE_RUN_TOOL}（employeeId=${empA.id}, dryRun:false）で後から取り戻せます`);
    expect(errs[0].metadata?.auditClass).toBe("admin");
    expectCleanErrorsAudit(errs[0]);
    // Bind succeeded → never the burned-link notice.
    expect(posts().some((c) => String(c.body.text).includes("無効になりました"))).toBe(false);
    expect(getRuntimeAudit().some((e) => e.metadata?.event === "slack_authorize_link.rejected" && e.metadata?.linkId === state.linkId)).toBe(false);
  });

  test("dmAutoroute throws → completion notice still sent; completed_with_errors names dm_autoroute", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const dm = dmSpy(async () => {
      throw new Error(`boom ${NEW_USER_TOKEN} ${empASlack}`);
    });
    const { state, result } = await linkWith(dm.fn);
    expect(result.ok).toBe(true);
    expect(dm.seen).toHaveLength(1);
    expect(posts().some((c) => String(c.body.text).includes("Slack 連携が完了しました"))).toBe(true);
    const errs = events(state.linkId, "slack_authorize_link.completed_with_errors");
    expect(errs).toHaveLength(1);
    expect(errs[0].metadata?.failedSteps).toEqual([{ step: "dm_autoroute", code: "exception" }]);
    expect(String(errs[0].metadata?.nextStepJa)).toContain("dryRun:false");
    expectCleanErrorsAudit(errs[0]);
  });

  test("dmAutoroute returns error / failed routes → reason code recorded", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const a = await linkWith(dmSpy(async () => ({ status: "error", reason: "unexpected_error", items: [] })).fn);
    expect(events(a.state.linkId, "slack_authorize_link.completed_with_errors")[0].metadata?.failedSteps).toEqual([
      { step: "dm_autoroute", code: "unexpected_error" },
    ]);
    const b = await linkWith(
      dmSpy(async () => ({
        status: "done",
        items: [{ counterpartSlackUserId: "UOTHERPERSON1", outcome: "failed", reason: "conversations_open_ratelimited" }],
      })).fn
    );
    const row = events(b.state.linkId, "slack_authorize_link.completed_with_errors")[0];
    expect(row.metadata?.failedSteps).toEqual([{ step: "dm_autoroute", code: "routes_failed" }]);
    expect(JSON.stringify(row).includes("UOTHERPERSON1")).toBe(false);
  });

  test("both fail → both listed, in order; still success", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const { state, result } = await linkWith(dmSpy(async () => ({ status: "error", reason: "unexpected_error", items: [] })).fn, { failNotice: true });
    expect(result.ok).toBe(true);
    expect(events(state.linkId, "slack_authorize_link.completed_with_errors")[0].metadata?.failedSteps).toEqual([
      { step: "completion_notice", code: "channel_not_found" },
      { step: "dm_autoroute", code: "unexpected_error" },
    ]);
  });

  test("deferFollowUps: the callback returns before follow-ups run (route passes next/server after())", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const dm = dmSpy(ok);
    const jobs: Array<() => Promise<void>> = [];
    const { state, result } = await linkWith(dm.fn, { defer: (job) => jobs.push(job) });
    expect(result.ok).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(dm.seen).toHaveLength(0);
    expect(posts().some((c) => String(c.body.text).includes("Slack 連携が完了しました"))).toBe(false);
    await jobs[0]();
    expect(dm.seen).toHaveLength(1);
    expect(posts().some((c) => String(c.body.text).includes("Slack 連携が完了しました"))).toBe(true);
    expect(events(state.linkId, "slack_authorize_link.completed_with_errors")).toHaveLength(0);
  });

  test("route source: link branch hands follow-ups to after(), no separate dmAutoroute schedule", () => {
    const src = readFileSync(new URL("../../app/api/slack/oauth/callback/route.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("if (parsed.linkId)"), src.indexOf("if (oauthError)"));
    expect(branch).toContain("deferFollowUps");
    expect(branch.includes("scheduleDmAutoroute(")).toBe(false);
  });

  test("nextStep resolver (追記 4): dmAutoroute.run only when registered AND SLACK_DM_AUTOROUTE_ENABLED is ON", async () => {
    for (const present of [true, false]) {
      for (const on of [true, false]) {
        setDmAutorouteFlag(on);
        await withRegistry(DM_AUTOROUTE_RUN_TOOL, present ? PRESENT : ABSENT, async () => {
          const step = await resolveAuthorizeLinkFollowUpNextStep(empA.id, ["completion_notice"]);
          expect(step.nextStepJa).toContain("完了の DM");
          if (present && on) {
            expect(step.recoveryAdminTool).toBe(DM_AUTOROUTE_RUN_TOOL);
            expect(step.nextStepJa).toContain(`${DM_AUTOROUTE_RUN_TOOL}（employeeId=${empA.id}, dryRun:false）で後から取り戻せます`);
          } else {
            expect(step.recoveryAdminTool).toBeNull();
            expect(step.nextStepJa.includes("dryRun:false")).toBe(false);
            expect(step.nextStepJa.includes(DM_AUTOROUTE_RUN_TOOL)).toBe(false);
          }
        });
      }
    }
  });

  test("completion notice fails while SLACK_DM_AUTOROUTE_ENABLED is OFF → completed_with_errors without the dmAutoroute.run step", async () => {
    setDmAutorouteFlag(false);
    const dm = dmSpy(ok);
    const { state } = await linkWith(dm.fn, { failNotice: true });
    expect(dm.seen).toHaveLength(0);
    const errs = events(state.linkId, "slack_authorize_link.completed_with_errors");
    expect(errs).toHaveLength(1);
    expect(errs[0].metadata?.failedSteps).toEqual([{ step: "completion_notice", code: "channel_not_found" }]);
    expect(errs[0].metadata?.recoveryAdminTool).toBeNull();
    expect(String(errs[0].metadata?.nextStepJa).includes("dryRun:false")).toBe(false);
  });

  test("setup.slackDmApprovalStatus: the employee whose last link completed_with_errors gets the dmAutoroute.run step; cleared after a clean re-link", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    const others = getRuntimeEmployees().filter((e) => e.orgId === ORG_A && e.id !== empA.id && e.status === "active");
    for (const e of others) e.status = "suspended";
    try {
      await linkWith(dmSpy(async () => ({ status: "error", reason: "unexpected_error", items: [] })).fn);
      const on = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
      const steps = (on.nextStepsJa as string[]).join("\n");
      expect(steps).toContain(`${empA.displayName}: `);
      expect(steps).toContain(`${DM_AUTOROUTE_RUN_TOOL}（employeeId=${empA.id}, dryRun:false）で後から取り戻せます`);
      const row = (on.employees as Array<Record<string, unknown>>).find((r) => r.employeeId === empA.id)!;
      expect(row.authorizeLinkFollowUpErrors).toEqual(["dm_autoroute"]);
      noSecrets(on);

      await linkWith(dmSpy(ok).fn);
      const after = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
      const row2 = (after.employees as Array<Record<string, unknown>>).find((r) => r.employeeId === empA.id)!;
      expect(row2.authorizeLinkFollowUpErrors).toEqual([]);
      expect((after.nextStepsJa as string[]).join("\n").includes(`${DM_AUTOROUTE_RUN_TOOL}（employeeId=${empA.id}, dryRun:false）`)).toBe(false);
    } finally {
      for (const e of others) e.status = "active";
    }
  });
});
