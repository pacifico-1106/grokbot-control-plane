import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { computeSlackStatusNextStepJa, diagnoseSlackStatus, type SlackStatusNextStepInput } from "@/lib/slack/slack-status-diagnose";
import { __resetChannelScopeDemoStore, setOrgChannelScopePolicy, upsertEmployeeChannelMembership } from "./data";
import { channelScopeNextStepJa, type ChannelScopeSetupStatus } from "./setup-status";
import { defaultChannelScopePolicy } from "./validate";

const ORG = DEMO_ORG.id;
const saved = process.env.P1_CHANNEL_SCOPE_ENABLED;
const savedFetch = globalThis.fetch;
let calls: string[] = [];
let botScopes = { channels: true, users: true };

beforeEach(async () => {
  __resetChannelScopeDemoStore();
  calls = [];
  botScopes = { channels: true, users: true };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.replace(/\?.*$/, ""));
    if (url.includes("auth.test")) return Response.json({ ok: true, bot_id: "B1", user_id: "U0BOT" });
    if (url.includes("files.getUploadURLExternal")) return Response.json({ ok: true, upload_url: "https://files.slack.com/x", file_id: "F1" });
    if (url.includes("users.conversations"))
      return Response.json(botScopes.channels ? { ok: true, channels: [] } : { ok: false, error: "missing_scope", needed: "channels:read,groups:read" });
    if (url.includes("users.info"))
      return Response.json(botScopes.users ? { ok: true, user: { id: "U0BOT" } } : { ok: false, error: "missing_scope", needed: "users:read" });
    return Response.json({ ok: false, error: "unexpected" });
  }) as typeof fetch;
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, secrets: { botToken: "xoxb-cs6" } });
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} });
});

afterAll(() => {
  if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
});

describe("setup.slackStatus channelScope section", () => {
  test("flag OFF ⇒ no channelScope field and no extra Slack calls", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const status = await diagnoseSlackStatus(ORG);
    expect("channelScope" in status).toBe(false);
    expect(calls.some((u) => u.includes("users.conversations") || u.includes("users.info"))).toBe(false);
    expect(status.nextStepJa).not.toContain("channelScope.patch");
  });

  test("flag ON, mode never chosen ⇒ nextStep asks for channelScope.patch", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    const status = await diagnoseSlackStatus(ORG);
    expect(status.channelScope?.tenantDefault).toMatchObject({ mode: "registered_only", chosen: false, source: "default" });
    expect(status.channelScope?.bot?.channelsRead.ready).toBe(true);
    expect(status.channelScope?.bot?.usersRead.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain("xoxb-cs6");
  });

  test("flag ON, all_joined + bot missing channels:read / users:read ⇒ issues and the scope step", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    botScopes = { channels: false, users: false };
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), mode: "all_joined" });
    const status = await diagnoseSlackStatus(ORG);
    const cs = status.channelScope!;
    expect(cs.tenantDefault.chosen).toBe(true);
    expect(cs.allJoinedEmployees).toBeGreaterThan(0);
    expect(cs.bot?.channelsRead).toMatchObject({ ready: false, code: "missing_scope", needed: "channels:read,groups:read" });
    expect(cs.nextStepJa).toContain("channels:read, groups:read");
    expect(status.issues.some((i) => i.includes("channels:read"))).toBe(true);
    expect(status.issues.some((i) => i.includes("users:read"))).toBe(true);
  });

  test("events observed estimate", async () => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), mode: "all_joined" });
    expect((await diagnoseSlackStatus(ORG)).channelScope?.eventsObserved).toBe(false);
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: "emp_comm", externalId: "C0CS6REC", via: "user", state: "member", eventId: "reconcile:x" });
    expect((await diagnoseSlackStatus(ORG)).channelScope?.eventsObserved).toBe(false);
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: "emp_comm", externalId: "C0CS6EVT", via: "user", state: "member", eventId: "Ev0CS6" });
    expect((await diagnoseSlackStatus(ORG)).channelScope?.eventsObserved).toBe(true);
  });
});

describe("nextStep ordering (pure)", () => {
  const base: SlackStatusNextStepInput = {
    botTokenPresent: true,
    authTest: { ok: true },
    botHasFilesWrite: true,
    botFilesWriteCode: "ok",
    adapterEnabled: true,
    imRoutesCount: 0,
    postingMismatch: [],
    employees: [],
    pathBReadiness: { pathBEmployeeCount: 0, linkedCount: 0, fileUploadReadyCount: 0, needsReoauthCount: 0, needsAuthorizeCount: 0, ready: true },
  };

  test("channel scope step comes right before channels.classify", () => {
    expect(computeSlackStatusNextStepJa(base)).toContain("channels.classify");
    expect(computeSlackStatusNextStepJa({ ...base, channelScopeNextStepJa: "SCOPE" })).toBe("SCOPE");
    expect(computeSlackStatusNextStepJa({ ...base, channelScopeNextStepJa: null })).toContain("channels.classify");
    // Earlier blockers still win.
    expect(computeSlackStatusNextStepJa({ ...base, adapterEnabled: false, channelScopeNextStepJa: "SCOPE" })).not.toBe("SCOPE");
  });

  test("channelScopeNextStepJa priorities", () => {
    const s = (p: Partial<ChannelScopeSetupStatus>): ChannelScopeSetupStatus => ({
      enabled: true,
      connectEnabled: false,
      tenantDefault: { mode: "all_joined", includeSlackConnect: false, source: "org", chosen: true },
      allJoinedEmployees: 1,
      bot: { channelsRead: { ready: true, code: "ok", needed: null }, usersRead: { ready: true, code: "ok", needed: null } },
      userTokens: [],
      eventsObserved: true,
      eventSubscriptionNoteJa: "NOTE",
      unconfirmedConnectCount: 0,
      issues: [],
      nextStepJa: null,
      ...p,
    });
    expect(channelScopeNextStepJa(s({ tenantDefault: { mode: "registered_only", includeSlackConnect: false, source: "default", chosen: false } }))).toContain("channelScope.patch");
    expect(channelScopeNextStepJa(s({ allJoinedEmployees: 0, eventsObserved: false }))).toBeNull();
    expect(channelScopeNextStepJa(s({ userTokens: [{ employeeId: "e1", displayName: "稲盛", channelsRead: { ready: false, code: "missing_scope", needed: null } }] }))).toContain("稲盛");
    expect(channelScopeNextStepJa(s({ eventsObserved: false }))).toContain("NOTE");
    expect(channelScopeNextStepJa(s({ bot: { channelsRead: { ready: true, code: "ok", needed: null }, usersRead: { ready: false, code: "missing_scope", needed: null } } }), true)).toContain("users:read");
    expect(channelScopeNextStepJa(s({}))).toBeNull();
  });
});
