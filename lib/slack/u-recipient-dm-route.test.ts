/**
 * Item C (木村 2026-10-09, triage #5 / T6): a Slack send whose recipient is a
 * U… user id (put in the channel field) is mapped to the employee's internal
 * 1:1 DM route — ONLY when the party ledger has that user as an INTERNAL
 * slack_user of the same org. Everyone else stops with a nextStep.
 * Gated by SLACK_DM_AUTOROUTE_ENABLED (OFF by default).
 *
 * Demo mode, dummy ids, Slack Web API mocked (no network).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { getOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { getSlackImEmployeeRoute } from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import type { Employee, GatewayInvokeRequest } from "@/lib/types";
import { slackApiArgs, slackRequestHeader } from "@/tests/helpers/slack-api-args";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const TEAM = "TUDMTEAM01";
const EMP_SLACK = "U0UDMEMP01";
const USER_TOKEN = "xoxp-udm-SECRET-user-token-1";
const BOT_TOKEN = "xoxb-udm-bot-token-1";
const TEXT = "来週の定例の議題を共有します。";
const FLAG = "SLACK_DM_AUTOROUTE_ENABLED";

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

function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`.replace(/[^A-Z0-9]/gi, "").slice(0, 20);
}
const dmFor = (counterpart: string) => `D${counterpart.slice(1, 12)}X`.toUpperCase();
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
  process.env[FLAG] = "1";
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
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
});

describe("internal ledger user → resolved to the internal DM route and sent", () => {
  test("U… of an internal slack_user: conversations.open (employee token) → D… → posted there as the employee", async () => {
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
    const open = calls.find((c) => c.method === "conversations.open")!;
    expect(open.args.users).toBe(u);
    expect(open.auth).toBe(`Bearer ${USER_TOKEN}`);
    expect(posts().length).toBe(1);
    expect(posts()[0].args.channel).toBe(dmFor(u));
    expect(posts()[0].auth).toBe(`Bearer ${USER_TOKEN}`);
    // Never posted to the bare U… (no bot app-DM fallback).
    expect(calls.some((c) => c.method === "chat.postMessage" && c.args.channel === u)).toBe(false);
    const route = await getSlackImEmployeeRoute(ORG, dmFor(u));
    expect(route?.employeeId).toBe(EMP);
    expect(route?.counterpartSlackUserId).toBe(u);
    expect((await getOrgChannel(ORG, "slack", dmFor(u)))?.classification).toBe("internal");
  });

  test("a second send reuses the same route (idempotent) and still re-verifies with Slack", async () => {
    const u = await party("internal");
    expect((await invoke(sendTo(u))).body.ok).toBe(true);
    calls = [];
    const r = await invoke(sendTo(u));
    expect(r.body.ok).toBe(true);
    expect(methods()).toContain("conversations.open");
    expect(posts().map((p) => p.args.channel)).toEqual([dmFor(u)]);
  });
});

describe("everyone else stops with a nextStep (BOLA / fail-closed)", () => {
  test("external slack_user in the ledger → refused, no Slack lookup, no post, IDs-only audit", async () => {
    const u = await party("external");
    const body = sendTo(u);
    const r = await invoke(body);
    expect(r.httpStatus).toBe(403);
    expectStopped(r, "slack_recipient_not_internal_party");
    expect(methods()).not.toContain("conversations.open");
    expectIdsOnlyAudit(String(body.jobId), "slack_recipient_not_internal_party");
  });

  test("unknown U… (not in the ledger) → refused", async () => {
    const u = uid("UNK");
    const r = await invoke(sendTo(u));
    expect(r.httpStatus).toBe(403);
    expectStopped(r, "slack_recipient_not_internal_party");
    expect(methods()).not.toContain("conversations.open");
  });

  test("another org's INTERNAL party → refused (the ledger is read for the employee's org only)", async () => {
    const u = await party("internal", { orgId: "org_udm_other" });
    const r = await invoke(sendTo(u, { conversation: { orgId: "org_udm_other" } }));
    expect(r.httpStatus).toBe(403);
    expectStopped(r, "slack_recipient_not_internal_party");
    expect(methods()).not.toContain("conversations.open");
  });

  test("guest (ledger says internal, Slack says restricted) → refused, no DM opened", async () => {
    const u = await party("internal", { user: { is_restricted: true } });
    const r = await invoke(sendTo(u));
    expect(r.httpStatus).toBe(403);
    expectStopped(r, "slack_recipient_not_eligible");
    expect(methods()).not.toContain("conversations.open");
  });

  test("other-workspace / Slack Connect stranger → refused", async () => {
    const u = await party("internal", { user: { is_stranger: true, team_id: "TOTHER0001" } });
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_recipient_not_eligible");
  });

  test("the employee's own Slack user id → refused (not a counterpart)", async () => {
    await upsertOrgParty({ orgId: ORG, kind: "slack_user", identifier: EMP_SLACK, audience: "internal" });
    const r = await invoke(sendTo(EMP_SLACK));
    expect(r.body.ok).toBe(false);
    expect(posts().length).toBe(0);
  });

  test("bot-posting employee (no user-token DM route) → refused with a dm=true / postingAs nextStep", async () => {
    patchEmployee({ postingAs: "bot" });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_autoroute_identity_required");
    expect(methods()).not.toContain("conversations.open");
  });

  test("U… in the user field without a channel and without dm=true is still refused (no DM to an arbitrary U…)", async () => {
    const u = await party("internal");
    const r = await invoke({
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId: jid("nochan"),
      conversation: { surface: "slack", slackUserId: u },
      args: { text: TEXT },
    } as GatewayInvokeRequest);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe("slack_channel_required");
    expect(posts().length).toBe(0);
    expect(methods()).not.toContain("conversations.open");
  });
});

describe("missing im:write / conversations.open failure → safe stop with guidance", () => {
  test("token without im:write → slack_dm_reauthorize_required, nextStep names im:write, IDs-only audit", async () => {
    scopes = "chat:write,users:read,im:history";
    const u = await party("internal");
    const body = sendTo(u);
    const r = await invoke(body);
    expect(r.httpStatus).toBe(409);
    expectStopped(r, "slack_dm_reauthorize_required");
    expect(String(r.body.nextStepJa)).toContain("im:write");
    expect(String(r.body.nextStep)).toContain("im:write");
    expect(r.body.retryable).toBe(false);
    expect(methods()).not.toContain("conversations.open");
    expectIdsOnlyAudit(String(body.jobId), "slack_dm_reauthorize_required");
  });

  test("conversations.open → missing_scope → slack_dm_reauthorize_required", async () => {
    openResponse = () => ({ ok: false, error: "missing_scope", needed: "im:write" });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_reauthorize_required");
    expect(String(r.body.nextStepJa)).toContain("im:write");
  });

  test("conversations.open → other error → slack_dm_open_failed (not silent), audited", async () => {
    openResponse = () => ({ ok: false, error: "ratelimited" });
    const u = await party("internal");
    const body = sendTo(u);
    const r = await invoke(body);
    expectStopped(r, "slack_dm_open_failed");
    expectIdsOnlyAudit(String(body.jobId), "slack_dm_open_failed");
  });
});

describe("the resolved channel is re-checked: a 1:1 IM with exactly that user", () => {
  test("conversations.open returns a non-IM channel id → refused", async () => {
    openResponse = (counterpart) => ({ ok: true, channel: { id: "C0NOTADM01", is_im: false, user: counterpart } });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_route_mismatch");
  });

  test("conversations.open returns a D… with a different user → refused, no route installed", async () => {
    const other = uid("UOTH");
    openResponse = (counterpart) => ({ ok: true, channel: { id: dmFor(counterpart), is_im: true, user: other } });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_route_mismatch");
    expect(await getSlackImEmployeeRoute(ORG, dmFor(u))).toBeNull();
  });

  test("conversations.open returns a D… without the user field → refused (unverifiable)", async () => {
    openResponse = (counterpart) => ({ ok: true, channel: { id: dmFor(counterpart), is_im: true } });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_route_mismatch");
  });

  test("an externally shared DM → refused", async () => {
    openResponse = (counterpart) => ({ ok: true, channel: { id: dmFor(counterpart), is_im: true, user: counterpart, is_ext_shared: true } });
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    expectStopped(r, "slack_dm_route_mismatch");
  });
});

describe("the AI cannot lower the class or make a recipient internal", () => {
  test("informationClass / audience claims in the request do not make an external U… internal", async () => {
    const u = await party("external");
    const r = await invoke(
      sendTo(u, {
        args: { informationClass: "public", audience: "internal", internal: true, recipientAudience: "internal" },
        conversation: { audience: "internal", slackTeamId: TEAM, speakerTeamId: TEAM },
      })
    );
    expectStopped(r, "slack_recipient_not_internal_party");
    expect(methods()).not.toContain("conversations.open");
  });

  test("an unknown U… with the employee's own team id claimed is still refused (team rule is not a source)", async () => {
    const u = uid("UNK");
    users.set(u, member(u));
    const r = await invoke(sendTo(u, { conversation: { slackTeamId: TEAM }, args: { slackTeamId: TEAM } }));
    expectStopped(r, "slack_recipient_not_internal_party");
  });
});

describe("flag OFF: unchanged", () => {
  test("no autoroute Slack call; the U… is not rewritten to a D…; none of the new codes", async () => {
    delete process.env[FLAG];
    const u = await party("internal");
    const r = await invoke(sendTo(u));
    for (const m of ["auth.test", "users.info", "conversations.open"]) expect(methods()).not.toContain(m);
    expect(posts().some((p) => String(p.args.channel).startsWith("D"))).toBe(false);
    expect([
      "slack_recipient_not_internal_party",
      "slack_recipient_not_eligible",
      "slack_dm_reauthorize_required",
      "slack_dm_open_failed",
      "slack_dm_route_mismatch",
      "slack_dm_autoroute_identity_required",
    ]).not.toContain(String(r.body.code));
    expect(await getSlackImEmployeeRoute(ORG, dmFor(u))).toBeNull();
    // Today's result on main: the U… is looked up as a channel, unknown → egress_denied.
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("egress_denied");
    expect(posts().length).toBe(0);
  });

  test("flag OFF, external U…: today's egress_denied, no Slack lookup", async () => {
    delete process.env[FLAG];
    const u = await party("external");
    const r = await invoke(sendTo(u));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("egress_denied");
    expect(methods()).not.toContain("conversations.open");
    expect(posts().length).toBe(0);
  });
});
