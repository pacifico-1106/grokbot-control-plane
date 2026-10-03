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
  SLACK_AUTHORIZE_LINK_PATH,
  completeAuthorizeLinkCallback,
  hashAuthorizeLinkToken,
  issueSlackAuthorizeLink,
  resolveAuthorizeLinkStart,
} from "@/lib/slack/authorize-link";
import { signSlackOAuthState, verifySlackOAuthState } from "@/lib/slack/oauth";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
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
    if (method === "users.info") return json({ ok: true, user: { id: String(body.user), team_id: team } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D${String(body.users).slice(1, 9)}`, is_im: true } });
    if (method === "chat.postMessage") return json({ ok: true, ts: "1700000000.0002" });
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
  savedFetch = globalThis.fetch;
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

  test("after approval: DM to the approver carries the link (unfurl off); result/audit carry only where it went", async () => {
    const queued = data(await callAdminMcpTool(TOOL, { employeeId: empA.id }, cred()));
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
    const issued = getRuntimeAudit().find((e) => e.metadata?.event === "slack_authorize_link.issued" && e.employeeId === empA.id)!;
    expect(issued.metadata?.deliveredUserId).toBe(APPROVER);
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
