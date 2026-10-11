/**
 * What the new bot scopes change at runtime (木村 10/10), pinned both ways with
 * a fake Slack API (dummy ids / tokens, demo mode):
 * - Not reinstalled yet (Slack answers missing_scope): conversations.info gives
 *   null (the ledger decides, as today) and users.info gives null (never
 *   internal → fail closed).
 * - Reinstalled (scopes granted): a Slack Connect channel is forced external
 *   and recorded as shared_external; an own-team user confirmed by users.info
 *   counts as internal ONLY when the org rule has autoSlackTeamInternal +
 *   that team id (#298), and only for the org's own bot token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { getOrgChannel, upsertOrgChannel } from "@/lib/data/directory";
import { clearDemoRule, setOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import {
  fetchVerifiedSlackUserTeamId,
  inspectSlackChannelExtShared,
  resetSlackUserTeamCacheForTests,
} from "@/lib/slack/bot-token";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_scope_other_tenant";
const OWN_TEAM = "T0OWNTEAM01";
const TOKEN = "xoxb-scope-test-own";
const originalFetch = globalThis.fetch;
let calls: Array<{ method: string; auth: string }> = [];

type Mode = "missing_scope" | "granted";
function mockSlack(mode: Mode, opts: { extShared?: boolean; userTeam?: string } = {}) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.replace("/api/", "");
    calls.push({ method, auth: new Headers(init?.headers).get("authorization") || "" });
    if (mode === "missing_scope") {
      const needed = method === "users.info" ? "users:read" : "channels:read";
      return Response.json({ ok: false, error: "missing_scope", needed, provided: "chat:write" });
    }
    if (method === "conversations.info") {
      return Response.json({ ok: true, channel: { id: url.searchParams.get("channel"), is_ext_shared: opts.extShared === true } });
    }
    if (method === "users.info") {
      return Response.json({ ok: true, user: { id: url.searchParams.get("user"), team_id: opts.userTeam ?? OWN_TEAM, deleted: false } });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

function ctxFor(channel: string | undefined, user: string | undefined) {
  return parseConversationContext(
    { tool: "comm.reply", conversation: { surface: "slack", ...(channel ? { slackChannelId: channel } : {}), ...(user ? { slackUserId: user } : {}) } } as never,
    ORG
  )!;
}

beforeEach(async () => {
  resetSlackUserTeamCacheForTests();
  clearDemoRule();
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, secrets: { botToken: TOKEN } });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetSlackUserTeamCacheForTests();
  clearDemoRule();
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

describe("workspace not reinstalled yet: Slack answers missing_scope", () => {
  test("conversations.info → null (ledger decides, as today); users.info → null", async () => {
    mockSlack("missing_scope");
    expect(await inspectSlackChannelExtShared(ORG, "C0SCOPECONN1")).toBeNull();
    expect(await fetchVerifiedSlackUserTeamId(ORG, "U0OWNUSER01")).toBeNull();
  });

  test("own-team user is NOT internal (fail closed) even with autoSlackTeamInternal + the team id", async () => {
    mockSlack("missing_scope");
    await setOrgInternalAudienceRule(ORG, { slackTeamIds: [OWN_TEAM], autoSlackTeamInternal: true }, "test");
    const v = await resolveAudience(ctxFor(undefined, "U0OWNUSER02"));
    expect(v.effectiveAudience).toBe("external");
  });

  test("a Connect channel the ledger has as internal is NOT re-recorded (cannot see it); the ledger row stays", async () => {
    mockSlack("missing_scope");
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0SCOPECONN2", classification: "internal", skipInspect: true });
    await resolveAudience(ctxFor("C0SCOPECONN2", undefined));
    expect((await getOrgChannel(ORG, "slack", "C0SCOPECONN2"))?.classification).toBe("internal");
  });
});

describe("reinstalled: scopes granted", () => {
  test("Slack Connect channel → external and recorded as shared_external (stricter)", async () => {
    mockSlack("granted", { extShared: true });
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0SCOPECONN3", classification: "internal", skipInspect: true });
    const v = await resolveAudience(ctxFor("C0SCOPECONN3", undefined));
    expect(v.effectiveAudience).toBe("external");
    const row = await getOrgChannel(ORG, "slack", "C0SCOPECONN3");
    expect(row?.classification).toBe("shared_external");
    expect(row?.mixed).toBe(true);
  });

  test("not ext-shared → nothing relaxed: an unclassified channel stays external", async () => {
    mockSlack("granted", { extShared: false });
    const v = await resolveAudience(ctxFor("C0SCOPEPLAIN", undefined));
    expect(v.effectiveAudience).toBe("external");
  });

  test("own-team user confirmed by users.info → internal only with autoSlackTeamInternal + that team (#298)", async () => {
    mockSlack("granted", { userTeam: OWN_TEAM });
    expect((await resolveAudience(ctxFor(undefined, "U0OWNUSER03"))).effectiveAudience).toBe("external");
    await setOrgInternalAudienceRule(ORG, { slackTeamIds: [OWN_TEAM], autoSlackTeamInternal: false }, "test");
    expect((await resolveAudience(ctxFor(undefined, "U0OWNUSER04"))).effectiveAudience).toBe("external");
    await setOrgInternalAudienceRule(ORG, { autoSlackTeamInternal: true }, "test");
    expect((await resolveAudience(ctxFor(undefined, "U0OWNUSER05"))).effectiveAudience).toBe("internal");
  });

  test("a user Slack reports in another team (Connect) stays external", async () => {
    mockSlack("granted", { userTeam: "T0OTHERCO99" });
    await setOrgInternalAudienceRule(ORG, { slackTeamIds: [OWN_TEAM], autoSlackTeamInternal: true }, "test");
    expect((await resolveAudience(ctxFor(undefined, "U0CONNECT01"))).effectiveAudience).toBe("external");
  });

  test("tenant isolation: only the org's own bot token is used; another org without a token makes no Slack call", async () => {
    mockSlack("granted", { extShared: true, userTeam: OWN_TEAM });
    await inspectSlackChannelExtShared(ORG, "C0SCOPECONN4");
    await fetchVerifiedSlackUserTeamId(ORG, "U0OWNUSER06");
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    calls = [];
    expect(await inspectSlackChannelExtShared(OTHER_ORG, "C0SCOPECONN4")).toBeNull();
    expect(await fetchVerifiedSlackUserTeamId(OTHER_ORG, "U0OWNUSER06")).toBeNull();
    expect(calls.length).toBe(0);
  });
});
