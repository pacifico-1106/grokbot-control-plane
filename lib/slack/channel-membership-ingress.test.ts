import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { updateWakeWebhook, listAuditEvents } from "@/lib/data";
import { upsertOrgChannel, getOrgChannel } from "@/lib/data/directory";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  getChannelScopeChannel,
  listEmployeeChannelMemberships,
  setEmployeeChannelScopeOverride,
  setOrgChannelScopePolicy,
} from "@/lib/channel-scope/data";
import { defaultChannelScopePolicy } from "@/lib/channel-scope/validate";
import type { ChannelScopePolicy } from "@/lib/channel-scope/types";

const ORG = DEMO_ORG.id;
const ME = "U0INAMORI";
const HOME = "T0SPACE";
const PEER = "T0PEER";
const SPEAKER = "U0HUMAN";
const BOT = "U0STAFFBOT";
const WAKE_URL = "https://example.test/wake/inamori";

const savedEnv = {
  scope: process.env.P1_CHANNEL_SCOPE_ENABLED,
  connect: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED,
  pathC: process.env.P0_USER_CHANNEL_MENTION_INGRESS,
};
const savedFetch = globalThis.fetch;
let seq = 0;
let channelInfo: Record<string, Record<string, unknown> | null> = {};
let infoCalls: string[] = [];
let wakeCalls: Record<string, unknown>[] = [];
let employeeId = "";
let restoreAllowed: (() => void) | null = null;

const evId = (tag: string) => `Ev0CS3${tag}${Date.now()}${(seq += 1)}`;
const chan = () => `C0CS3${Date.now().toString(36).toUpperCase()}${(seq += 1)}`;

function policy(p: Partial<ChannelScopePolicy>): ChannelScopePolicy {
  return { ...defaultChannelScopePolicy(), ...p, connect: { ...defaultChannelScopePolicy().connect, ...(p.connect ?? {}) } };
}

function userAuth() {
  return [{ is_bot: false, user_id: ME, team_id: HOME }];
}

function joined(channel: string, opts: { user?: string; auth?: unknown[]; eventId?: string; inviter?: string } = {}) {
  return processSlackMentionEnvelope({
    type: "event_callback",
    team_id: HOME,
    event_id: opts.eventId ?? evId("join"),
    authorizations: (opts.auth ?? userAuth()) as never,
    event: { type: "member_joined_channel", user: opts.user ?? ME, channel, channel_type: "C", team: HOME, inviter: opts.inviter ?? SPEAKER } as never,
  });
}

function mentionPathC(channel: string) {
  return processSlackMentionEnvelope({
    type: "event_callback",
    team_id: HOME,
    event_id: evId("msg"),
    authorizations: userAuth(),
    event: { type: "message", channel_type: "channel", user: SPEAKER, text: `<@${ME}> 確認お願いします`, ts: "1790000000.000100", channel },
  });
}

function appMention(channel: string) {
  return processSlackMentionEnvelope({
    type: "event_callback",
    team_id: HOME,
    event_id: evId("app"),
    authorizations: [{ is_bot: true, user_id: BOT, team_id: HOME }],
    event: { type: "app_mention", user: SPEAKER, text: `<@${BOT}> 見て`, ts: "1790000000.000200", channel },
  });
}

const internalInfo = { is_ext_shared: false, is_shared: false, is_org_shared: false, context_team_id: HOME };
const connectInfo = { is_ext_shared: true, is_shared: true, context_team_id: HOME, connected_team_ids: [HOME, PEER] };

beforeEach(async () => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
  delete process.env.P0_USER_CHANNEL_MENTION_INGRESS;
  __resetChannelScopeDemoStore();
  channelInfo = {};
  infoCalls = [];
  wakeCalls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/conversations.info")) {
      const id = new URL(url).searchParams.get("channel") || "";
      infoCalls.push(id);
      const info = channelInfo[id];
      return new Response(JSON.stringify(info ? { ok: true, channel: info } : { ok: false, error: "channel_not_found" }));
    }
    if (url.startsWith("https://slack.com/api/")) return new Response(JSON.stringify({ ok: true }));
    wakeCalls.push(JSON.parse(String(init?.body || "{}")));
    return new Response("ok");
  }) as typeof fetch;

  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  employeeId = emp.id;
  const prev = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: ME }];
  restoreAllowed = () => {
    emp.allowedAccounts = prev;
  };
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  await bindEmployeeSlackIdentity({ employeeId, orgId: ORG, slackUserId: ME, slackTeamId: HOME, displayName: "稲盛", userToken: "xoxp-cs3-test" });
  await updateWakeWebhook(employeeId, { orgId: ORG, url: WAKE_URL, secret: "wake-secret-cs3" });
  await setOrgInternalAudienceRule(ORG, { slackTeamIds: [HOME], autoSlackTeamInternal: true }, "test");
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  await updateWakeWebhook(employeeId, { orgId: ORG, url: null, secret: "" });
  restoreAllowed?.();
  clearDemoRule();
});

afterAll(() => {
  for (const [k, v] of [
    ["P1_CHANNEL_SCOPE_ENABLED", savedEnv.scope],
    ["P1_CHANNEL_SCOPE_CONNECT_ENABLED", savedEnv.connect],
    ["P0_USER_CHANNEL_MENTION_INGRESS", savedEnv.pathC],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const memberships = async (channel: string) => listEmployeeChannelMemberships(ORG, { employeeId, externalId: channel });

describe("flag OFF", () => {
  test("membership events keep the legacy unsupported_event_type path (no claim, no writes, no API)", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const c = chan();
    channelInfo[c] = internalInfo;
    const id = evId("off");
    const r = await joined(c, { eventId: id });
    expect(r).toMatchObject({ handled: false, skipReason: "unsupported_event_type" });
    expect(infoCalls).toEqual([]);
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    // Event id was not claimed while OFF.
    const again = await joined(c, { eventId: id });
    expect(again.duplicate).toBeUndefined();
  });
});

describe("member_joined_channel", () => {
  test("registered_only (default): only recorded as out_of_scope, no conversations.info, no ledger row", async () => {
    const c = chan();
    channelInfo[c] = internalInfo;
    const r = await joined(c);
    expect(r.channelMembership).toMatchObject({ eventType: "member_joined_channel", subjects: 1, applied: 1, failed: 0 });
    expect(infoCalls).toEqual([]);
    const [m] = await memberships(c);
    expect(m).toMatchObject({ state: "out_of_scope", via: "user", inviterSlackUserId: SPEAKER });
    expect(await getOrgChannel(ORG, "slack", c)).toBeNull();
    const audits = await listAuditEvents(ORG, 30);
    expect(audits.some((a) => a.action === "channel_scope.membership_recorded" && a.metadata?.channelId === c)).toBe(true);
  });

  test("same event_id twice is processed once", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    const id = evId("dup");
    const first = await joined(c, { eventId: id });
    const second = await joined(c, { eventId: id });
    expect(first.channelMembership?.applied).toBe(1);
    expect(second).toMatchObject({ duplicate: true, skipReason: "duplicate_event" });
    expect(infoCalls.length).toBe(1);
  });

  test("someone else's join is ignored and not stored", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    const r = await joined(c, { user: "U0SOMEONE" });
    expect(r.skipReason).toBe("channel_scope_not_self");
    expect(await listEmployeeChannelMemberships(ORG, { externalId: c })).toEqual([]);
    expect(infoCalls).toEqual([]);
  });

  test("all_joined + internal channel ⇒ auto_join internal, member, audit; Path C mention wakes", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    await joined(c);
    expect(infoCalls).toEqual([c]);
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "internal", mixed: false, source: "auto_join", slackTeamId: HOME });
    expect((await memberships(c))[0]).toMatchObject({ state: "member", via: "user" });
    const audit = (await listAuditEvents(ORG, 30)).find((a) => a.action === "channel_scope.auto_classified" && a.metadata?.channelId === c);
    expect(audit?.metadata).toMatchObject({ classification: "internal", basis: "home_team_internal", membershipState: "member", inviterSlackUserId: SPEAKER });
    expect(JSON.stringify(audit)).not.toContain("xoxp-");

    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    const wake = await mentionPathC(c);
    expect(wake).toMatchObject({ handled: true, woke: 1 });
  });

  test("all_joined + Connect without includeSlackConnect ⇒ shared_external, out_of_scope, no wake", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = connectInfo;
    await joined(c);
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "shared_external", mixed: true, externalTeamIds: [PEER], source: "auto_join" });
    expect((await memberships(c))[0].state).toBe("out_of_scope");
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    const wake = await mentionPathC(c);
    expect(wake.skipReason).toBe("channel_out_of_scope");
    expect(wakeCalls.length).toBe(0);
  });

  test("includeSlackConnect needs the Connect flag; with it, Connect joins are members and wake", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined", includeSlackConnect: true }));
    const c1 = chan();
    channelInfo[c1] = connectInfo;
    await joined(c1);
    expect((await memberships(c1))[0].state).toBe("out_of_scope"); // kill switch OFF ⇒ suppressed

    process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "1";
    const c2 = chan();
    channelInfo[c2] = connectInfo;
    await joined(c2);
    expect((await memberships(c2))[0].state).toBe("member");
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    expect((await mentionPathC(c2)).woke).toBe(1);
  });

  test("Connect team allowlist: other peers are out_of_scope", async () => {
    process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "1";
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined", includeSlackConnect: true, connect: { allowedExternalTeamIds: ["T0FRIEND"] } as never }));
    const c = chan();
    channelInfo[c] = connectInfo;
    await joined(c);
    expect((await memberships(c))[0].state).toBe("out_of_scope");
  });

  test("conversations.info failure ⇒ unknown (fail-closed), no wake", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = null;
    await joined(c);
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "unknown", source: "auto_join" });
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    const wake = await mentionPathC(c);
    expect(wake.woke).toBe(0);
    expect(wakeCalls.length).toBe(0);
  });

  test("an external team invite never makes a Connect channel internal", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
    channelInfo[c] = internalInfo; // Slack now claims "not shared"
    await joined(c);
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "shared_external", mixed: true, source: "manual" });
    const audit = (await listAuditEvents(ORG, 30)).find((a) => a.action === "channel_scope.auto_classified" && a.metadata?.channelId === c);
    expect(audit?.metadata?.rejectedWidening).toBe(true);
  });

  test("employee override (all_joined) beats the org default (registered_only)", async () => {
    await setEmployeeChannelScopeOverride(ORG, employeeId, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    await joined(c);
    expect((await memberships(c))[0].state).toBe("member");
  });
});

describe("leave / share events", () => {
  test("member_left_channel ⇒ left, and later mentions no longer wake", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    await joined(c);
    const r = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("left"),
      authorizations: userAuth(),
      event: { type: "member_left_channel", user: ME, channel: c, channel_type: "C", team: HOME } as never,
    });
    expect(r.channelMembership?.applied).toBe(1);
    expect((await memberships(c))[0]).toMatchObject({ state: "left" });
    expect((await memberships(c))[0].leftAt).toBeTruthy();
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    expect((await mentionPathC(c)).skipReason).toBe("channel_out_of_scope");
  });

  test("channel_shared makes the channel stricter at once, even when human-confirmed; members move out_of_scope", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    await joined(c);
    __setDemoChannelScopeMeta(ORG, "slack", c, { source: "auto_join", humanConfirmedAt: "2026-10-01T00:00:00.000Z", slackTeamId: HOME, externalTeamIds: [] });
    const r = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("shared"),
      authorizations: userAuth(),
      event: { type: "channel_shared", channel: c, connected_team_id: PEER } as never,
    });
    expect(r.channelMembership?.failed).toBe(0);
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({
      classification: "shared_external",
      mixed: true,
      externalTeamIds: [PEER],
      humanConfirmedAt: null, // confirmation of the internal state is stale ⇒ cleared
    });
    expect((await memberships(c))[0].state).toBe("out_of_scope");
    const audit = (await listAuditEvents(ORG, 30)).find((a) => a.action === "channel_scope.channel_shared" && a.metadata?.channelId === c);
    expect(audit?.metadata?.membershipsMovedOutOfScope).toEqual([employeeId]);
    expect(audit?.metadata?.humanConfirmationCleared).toBe(true);
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    expect((await mentionPathC(c)).skipReason).toBe("channel_out_of_scope");
  });

  test("channel_shared on a human-created (manual) row: stricter, but stays registered (CS1 semantics)", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", skipInspect: true });
    await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("sharedmanual"),
      authorizations: userAuth(),
      event: { type: "channel_shared", channel: c, connected_team_id: PEER } as never,
    });
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "shared_external", mixed: true, source: "manual" });
    // Ledger now says Connect ⇒ existing egress matrix treats it as external.
    expect((await getOrgChannel(ORG, "slack", c))?.classification).toBe("shared_external");
  });

  test("channel_unshared never widens back to internal", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "shared_external", mixed: true, skipInspect: true });
    const r = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("unshared"),
      authorizations: userAuth(),
      event: { type: "channel_unshared", channel: c, previously_connected_team_id: PEER, is_ext_shared: false } as never,
    });
    expect(r.skipReason).toBe("channel_scope_unshare_ignored");
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ classification: "shared_external", mixed: true });
  });

  test("unbound subject ⇒ ignored", async () => {
    const c = chan();
    const r = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("unbound"),
      authorizations: [{ is_bot: false, user_id: "U0NOBODY", team_id: HOME }],
      event: { type: "channel_left", channel: c } as never,
    });
    expect(r.skipReason).toBe("channel_scope_employee_not_bound");
  });

  test("DM / malformed channel ids are never part of channel scope", async () => {
    const r = await joined("D0DIRECT1");
    expect(r.skipReason).toBe("channel_scope_invalid_channel");
  });
});

describe("bot path", () => {
  beforeEach(async () => {
    await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, config: { teamId: HOME }, secrets: { botToken: "xoxb-cs3-test" } });
  });
  afterEach(async () => {
    await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, config: { teamId: HOME } });
  });

  test("registered_only keeps today's behavior: app_mention in an unregistered channel still wakes", async () => {
    const c = chan();
    const r = await appMention(c);
    expect(r.woke).toBe(1);
  });

  test("registered_only: auto-only (unconfirmed) channels do not wake on the bot path", async () => {
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", c, { source: "auto_join", humanConfirmedAt: null });
    const r = await appMention(c);
    expect(r).toMatchObject({ woke: 0, skipReason: "channel_out_of_scope" });
    expect((await listAuditEvents(ORG, 30)).some((a) => a.action === "channel_scope.wake_skipped" && a.metadata?.channel === c)).toBe(true);
  });

  test("bot join ⇒ via=bot membership (bot token used for conversations.info); channel_left by someone else ⇒ removed and no wake", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    channelInfo[c] = internalInfo;
    const j = await joined(c, { user: BOT, auth: [{ is_bot: true, user_id: BOT, team_id: HOME }] });
    expect(j.channelMembership).toMatchObject({ subjects: 1, applied: 1 });
    expect((await memberships(c))[0]).toMatchObject({ via: "bot", state: "member" });
    expect((await appMention(c)).woke).toBe(1);

    const left = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: HOME,
      event_id: evId("botleft"),
      authorizations: [{ is_bot: true, user_id: BOT, team_id: HOME }],
      event: { type: "channel_left", channel: c, actor_id: SPEAKER } as never,
    });
    expect(left.channelMembership?.applied).toBe(1);
    expect((await memberships(c))[0].state).toBe("removed");
    expect((await appMention(c)).skipReason).toBe("channel_out_of_scope");
  });

  test("bot join without an enabled adapter for the team ⇒ ignored", async () => {
    await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, config: { teamId: "T0ELSEWHERE" }, secrets: { botToken: "xoxb-cs3-test" } });
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    const j = await joined(c, { user: BOT, auth: [{ is_bot: true, user_id: BOT, team_id: HOME }] });
    expect(j.skipReason).toBe("channel_scope_bot_adapter_not_found");
  });

  test("flag OFF: bot path is untouched even for auto-only rows", async () => {
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", c, { source: "auto_join", humanConfirmedAt: null });
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    expect((await appMention(c)).woke).toBe(1);
  });
});
