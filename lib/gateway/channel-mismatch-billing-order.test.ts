/**
 * #357 follow-up (木村 10/12, withdrew the OK to run it before the gate): the
 * same-person U…/D… check (auth.test, users.info, conversations.open) runs only
 * AFTER the billing gate. A billing refusal means no Slack call at all and nothing
 * sent. W… ids (Enterprise Grid) stay accepted.
 *
 * Demo mode, dummy ids, Slack Web API mocked (no network).
 */
import { mock } from "bun:test";
import * as realEntitlements from "@/lib/billing/entitlements";

// Captured before mock.module (it live-updates the namespace). Default: the real gate.
const realGate = realEntitlements.assertBillingAllowsGateway;
let billingRefuses = false;
let billingThrows = false;
mock.module("@/lib/billing/entitlements", () => ({
  ...realEntitlements,
  assertBillingAllowsGateway: async (orgId: string | null | undefined, tool: string) => {
    if (billingThrows) throw new Error("entitlements_unavailable");
    if (!billingRefuses) return realGate(orgId, tool);
    const real = await realGate(orgId, tool);
    return { ok: false, code: "expired_trial_gated", tool, entitlements: real.entitlements };
  },
}));
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { getOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { getSlackImEmployeeRoute } from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { getApprovalById } from "@/lib/data";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee, GatewayInvokeRequest } from "@/lib/types";
import { slackApiArgs, slackRequestHeader } from "@/tests/helpers/slack-api-args";
import { syncAutoDmRoutesForEmployee } from "@/lib/slack/dm-autoroute";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const TEAM = "TUDMTEAM01";
const EMP_SLACK = "U0UDMEMP01";
const USER_TOKEN = "xoxp-udm-SECRET-user-token-1";
const BOT_TOKEN = "xoxb-udm-bot-token-1";
const TEXT = "来週の定例の議題を共有します。";
const FLAG = "SLACK_DM_AUTOROUTE_ENABLED";
const SEND_FLAG = "SLACK_U_TO_DM_SEND_ENABLED";
const IM_WRITE_FLAG = "SLACK_USER_SCOPE_IM_WRITE";

type Call = { method: string; args: Record<string, unknown>; auth: string };
let calls: Call[] = [];
let scopes = "chat:write,users:read,im:history,im:write";
let users = new Map<string, Record<string, unknown>>();
let openResponse: (counterpart: string) => Record<string, unknown>;
let seq = 0;
let postSeq = 0;
const originalFetch = globalThis.fetch;
const restorers: Array<() => void> = [];
const savedFlag = process.env[FLAG];
const savedSendFlag = process.env[SEND_FLAG];
const savedImWriteFlag = process.env[IM_WRITE_FLAG];

function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`.replace(/[^A-Z0-9]/gi, "").slice(0, 20);
}
// full id (the Item C copy truncates, so two parties made in the same ms could share a D…)
const dmFor = (counterpart: string) => `D${counterpart.slice(1)}X`.toUpperCase();
const jid = (s: string) => `job_udm_${s}_${Date.now()}_${++seq}`;

function installFetch() {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = String(input).replace("https://slack.com/api/", "").split("?")[0];
    const args = slackApiArgs(method, init);
    const auth = slackRequestHeader(init, "authorization");
    calls.push({ method, args, auth });
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "auth.test") {
      return json({ ok: true, user_id: EMP_SLACK, team_id: TEAM }, { "x-oauth-scopes": scopes });
    }
    if (method === "users.info") {
      const user = users.get(String(args.user));
      return user ? json({ ok: true, user }) : json({ ok: false, error: "user_not_found" });
    }
    if (method === "conversations.open") return json(openResponse(String(args.users)));
    if (method === "chat.postMessage") {
      postSeq += 1;
      return json({ ok: true, channel: String(args.channel), ts: `1788000000.${String(postSeq).padStart(6, "0")}` });
    }
    if (method === "conversations.info") return json({ ok: false, error: "channel_not_found" });
    return json({ ok: true });
  }) as unknown as typeof fetch;
}

function patchEmployee(patch: Partial<Employee>) {
  const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
  const previous = { ...emp };
  Object.assign(emp, patch);
  restorers.push(() => {
    for (const key of Object.keys(emp)) delete (emp as unknown as Record<string, unknown>)[key];
    Object.assign(emp, previous);
  });
}

function member(id: string, extra: Record<string, unknown> = {}) {
  return { id, team_id: TEAM, deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false, ...extra };
}

/** A U… registered in the ledger (and known to users.info). */
async function party(audience: "internal" | "external", opts: { orgId?: string; user?: Record<string, unknown> } = {}) {
  const id = uid("UCP");
  users.set(id, member(id, opts.user ?? {}));
  await upsertOrgParty({ orgId: opts.orgId ?? ORG, kind: "slack_user", identifier: id, audience });
  return id;
}

/** comm.reply with the U… in the channel fields (the T6 shape). */
function sendTo(recipient: string, extra: { args?: Record<string, unknown>; conversation?: Record<string, unknown> } = {}): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: jid("send"),
    conversation: { surface: "slack", slackChannelId: recipient, ...(extra.conversation ?? {}) },
    args: { slackChannelId: recipient, text: TEXT, ...(extra.args ?? {}) },
  } as GatewayInvokeRequest;
}

const invoke = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: EMP, credentialId: "cred_comm", body });
const methods = () => calls.map((c) => c.method);
const posts = () => calls.filter((c) => c.method === "chat.postMessage");
const autorouteAudits = (jobId: string) =>
  getRuntimeAudit().filter((e) => e.orgId === ORG && (e.metadata as Record<string, unknown>)?.jobId === jobId && e.action === "slack.post_failed");

function expectStopped(r: Awaited<ReturnType<typeof invoke>>, code: string) {
  expect(r.body.ok).toBe(false);
  expect(r.body.code).toBe(code);
  expect(typeof r.body.nextStep).toBe("string");
  expect(String(r.body.nextStep).length).toBeGreaterThan(10);
  expect(typeof r.body.nextStepJa).toBe("string");
  expect(r.body.needs_approval).toBe(false);
  expect(posts().length).toBe(0);
  expect(JSON.stringify(r.body)).not.toContain(TEXT);
  expect(JSON.stringify(r.body)).not.toContain(USER_TOKEN);
}

function expectIdsOnlyAudit(jobId: string, code: string) {
  const rows = autorouteAudits(jobId);
  expect(rows.length).toBe(1);
  expect((rows[0].metadata as Record<string, unknown>).code).toBe(code);
  const raw = JSON.stringify(rows[0]);
  expect(raw).not.toContain(TEXT);
  expect(raw).not.toContain(USER_TOKEN);
}

beforeEach(async () => {
  billingRefuses = false;
  billingThrows = false;
  process.env[FLAG] = "1";
  process.env[SEND_FLAG] = "1";
  process.env[IM_WRITE_FLAG] = "1";
  scopes = "chat:write,users:read,im:history,im:write";
  users = new Map();
  openResponse = (counterpart) => ({ ok: true, channel: { id: dmFor(counterpart), is_im: true, user: counterpart } });
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, secrets: { botToken: BOT_TOKEN } });
  patchEmployee({ postingAs: "user", allowedAccounts: [{ service: "slack", accountId: EMP_SLACK }] as Employee["allowedAccounts"] });
  await bindEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG, slackUserId: EMP_SLACK, slackTeamId: TEAM, userToken: USER_TOKEN });
  installFetch();
});

afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  globalThis.fetch = originalFetch;
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedSendFlag === undefined) delete process.env[SEND_FLAG];
  else process.env[SEND_FLAG] = savedSendFlag;
  if (savedImWriteFlag === undefined) delete process.env[IM_WRITE_FLAG];
  else process.env[IM_WRITE_FLAG] = savedImWriteFlag;
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
});


/** Install the internal DM route for `u` (as a DM wake would find it), then reset the call log. */
async function dmWakeFor(u: string): Promise<string> {
  const r = await invoke(sendTo(u));
  expect(r.body.ok).toBe(true);
  const d = dmFor(u);
  expect((await getSlackImEmployeeRoute(ORG, d))?.counterpartSlackUserId).toBe(u);
  calls = [];
  return d;
}

/** comm.reply on a DM wake: conversation.slackChannelId = D…, plus whatever the AI put in args. */
function onDmWake(d: string, args: Record<string, unknown>): GatewayInvokeRequest {
  return {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: jid("wake"),
    conversation: { surface: "slack", slackChannelId: d },
    args: { text: TEXT, ...args },
  } as GatewayInvokeRequest;
}

function expectMismatch(r: Awaited<ReturnType<typeof invoke>>, ids: string[]) {
  expect(r.httpStatus).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.code).toBe("conversation_channel_mismatch");
  expect(r.body.sent).toBe(false);
  expect(r.body.needs_approval).toBe(false);
  expect(posts().length).toBe(0);
  const raw = JSON.stringify(r.body);
  for (const id of ids) expect(raw).not.toContain(id);
  expect(raw).not.toContain(TEXT);
  expect(raw).not.toContain(USER_TOKEN);
}

describe("billing gate first: a refusal means no Slack call and nothing sent", () => {
  test("same-person U… on a D… wake while billing refuses → 402 expired_trial_gated (same as the gateway gate), no Slack call, nothing sent", async () => {
    const u = await party("internal");
    const d = await dmWakeFor(u);
    billingRefuses = true;
    const body = onDmWake(d, { channelId: u });
    const r = await invoke(body);
    expect(r.httpStatus).toBe(402);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe("expired_trial_gated");
    expect(r.body.error).toBe("expired_trial_gated");
    expect(r.body.sent).toBeUndefined();
    expect(calls).toEqual([]);
    expect(posts().length).toBe(0);
    const mismatch = getRuntimeAudit().find(
      (e) => (e.metadata as Record<string, unknown>)?.jobId === body.jobId && e.action === "gateway.conversation_channel_mismatch"
    );
    expect(mismatch).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("billing_gate");
    expect(JSON.stringify(r.body)).not.toContain(u);
    expect(JSON.stringify(r.body)).not.toContain(d);
  });

  test("billing refuses a send to the D… alone → 402 expired_trial_gated, no Slack call (unchanged)", async () => {
    const u = await party("internal");
    const d = await dmWakeFor(u);
    billingRefuses = true;
    const r = await invoke(onDmWake(d, {}));
    expect(r.httpStatus).toBe(402);
    expect(r.body.code).toBe("expired_trial_gated");
    expect(calls).toEqual([]);
  });

  test("billing gate throws → 503 unavailable (not a synthesized 402 / not fabricated entitlements)", async () => {
    const u = await party("internal");
    const d = await dmWakeFor(u);
    billingThrows = true;
    const body = onDmWake(d, { channelId: u });
    const r = await invoke(body);
    expect(r.httpStatus).toBe(503);
    expect(r.body.code).toBe("unavailable");
    expect(r.body.code).not.toBe("expired_trial_gated");
    expect(JSON.stringify(r.body)).not.toContain("billing_gate");
    expect(JSON.stringify(r.body)).not.toContain("\"plan\":\"trial\"");
    expect(calls).toEqual([]);
    expect(posts().length).toBe(0);
    expect(JSON.stringify(r.body)).not.toContain(u);
    expect(JSON.stringify(r.body)).not.toContain(d);
  });

  test("billing passes → the same request is resolved and delivered once to the D… (unchanged)", async () => {
    const u = await party("internal");
    const d = await dmWakeFor(u);
    const r = await invoke(onDmWake(d, { channelId: u }));
    expect(r.httpStatus).toBe(200);
    expect(posts().map((p) => p.args.channel)).toEqual([d]);
  });
});

describe("conversations.open only when everything lines up", () => {
  test("no stored route match → refused before any Slack call (even with billing OK)", async () => {
    const u = await party("internal");
    const other = await party("internal");
    const d = await dmWakeFor(u);
    const r = await invoke(onDmWake(d, { channelId: other }));
    expect(r.httpStatus).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("W… ids (Enterprise Grid) stay accepted", () => {
  test("a W… internal party on its D… wake → same destination, delivered once", async () => {
    const w = `W${uid("GRID").slice(0, 12)}`.toUpperCase();
    users.set(w, member(w));
    await upsertOrgParty({ orgId: ORG, kind: "slack_user", identifier: w, audience: "internal" });
    const d = await dmWakeFor(w);
    const r = await invoke(onDmWake(d, { channelId: w }));
    expect(r.httpStatus).toBe(200);
    expect(posts().map((p) => p.args.channel)).toEqual([d]);
  });
});
