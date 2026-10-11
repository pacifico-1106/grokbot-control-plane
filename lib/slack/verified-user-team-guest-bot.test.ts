/**
 * 木村 10/10 (follow-up to #311): users.info with the org's own bot token
 * reports the OWN team id for guests (single- / multi-channel), bots and some
 * Slack Connect strangers. Under autoSlackTeamInternal such a user must never
 * be judged internal by team: is_restricted / is_ultra_restricted / is_bot /
 * is_stranger (and deleted) → no verified team → callers fail closed
 * (external / unknown). A full member of the own team stays internal.
 * The negative verdict is cached like a positive one (never re-derived as
 * internal within the TTL). Dummy ids / tokens, demo mode.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { clearDemoRule, setOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import { validateReplyRecipient } from "@/lib/gateway/reply-recipient-validate";
import { fetchVerifiedSlackUserTeamId, resetSlackUserTeamCacheForTests, slackUserTeamCacheKeysForTests } from "@/lib/slack/bot-token";
import type { GatewayInvokeRequest } from "@/lib/types";

const ORG = DEMO_ORG.id;
const ORG_C = "org_guest_team_other";
const OWN = "T0GUESTOWN1";
const originalFetch = globalThis.fetch;
let calls: Array<{ auth: string; user: string }> = [];
let userFlags: Record<string, unknown> = {};
let teamFor: (auth: string) => string = () => OWN;

beforeEach(async () => {
  resetSlackUserTeamCacheForTests();
  clearDemoRule();
  calls = [];
  userFlags = {};
  teamFor = () => OWN;
  process.env.P0_REPLY_POLICY_ENHANCED = "true";
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, secrets: { botToken: "xoxb-guest-a" } });
  await upsertConversationAdapter({ orgId: ORG_C, surface: "slack", enabled: true, secrets: { botToken: "xoxb-guest-c" } });
  await setOrgInternalAudienceRule(ORG, { slackTeamIds: [OWN], autoSlackTeamInternal: true }, "test");
  await setOrgInternalAudienceRule(ORG_C, { slackTeamIds: [OWN], autoSlackTeamInternal: true }, "test");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") || "";
    if (url.pathname.endsWith("users.info")) {
      const user = url.searchParams.get("user") || "";
      calls.push({ auth, user });
      return Response.json({ ok: true, user: { id: user, team_id: teamFor(auth), deleted: false, ...userFlags } });
    }
    if (url.pathname.endsWith("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected" });
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.P0_REPLY_POLICY_ENHANCED;
  resetSlackUserTeamCacheForTests();
  clearDemoRule();
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await upsertConversationAdapter({ orgId: ORG_C, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

function ctx(user: string, orgId = ORG) {
  return parseConversationContext(
    { tool: "comm.reply", purpose: "comm.internal", conversation: { surface: "slack", slackUserId: user } } as GatewayInvokeRequest,
    orgId
  )!;
}

async function recipient(user: string) {
  return validateReplyRecipient({ orgId: ORG, employee: null, context: { surface: "slack" }, recipientIdentifier: user, recipientKind: "slack_user" });
}

describe("own team_id + a non-member flag → never internal by team", () => {
  for (const flag of ["is_restricted", "is_ultra_restricted", "is_bot", "is_stranger"]) {
    test(`${flag}: no verified team; audience.ts and reply-recipient-validate fail closed`, async () => {
      userFlags = { [flag]: true };
      const user = `U0${flag.replace(/[^a-z]/g, "").toUpperCase().slice(0, 10)}`;
      expect(await fetchVerifiedSlackUserTeamId(ORG, user)).toBeNull();
      const v = await resolveAudience(ctx(user));
      expect(v.audience).not.toBe("internal");
      expect(v.effectiveAudience).toBe("external");
      const r = await recipient(user);
      expect(r.status).toBe("needs_approval");
      expect(r.failClosed).toBe(true);
    });
  }

  test("deleted: same (never internal)", async () => {
    userFlags = { deleted: true };
    expect(await fetchVerifiedSlackUserTeamId(ORG, "U0DELETED1")).toBeNull();
    expect((await resolveAudience(ctx("U0DELETED1"))).effectiveAudience).toBe("external");
  });

  test("a flag set to false is not a reason to refuse", async () => {
    userFlags = { is_restricted: false, is_ultra_restricted: false, is_bot: false, is_stranger: false };
    expect(await fetchVerifiedSlackUserTeamId(ORG, "U0FALSEFLG")).toBe(OWN);
  });
});

describe("no regression: a full member of the own team", () => {
  test("still internal in audience.ts and allowed in reply-recipient-validate", async () => {
    expect(await fetchVerifiedSlackUserTeamId(ORG, "U0MEMBER01")).toBe(OWN);
    expect((await resolveAudience(ctx("U0MEMBER02"))).audience).toBe("internal");
    const r = await recipient("U0MEMBER03");
    expect(r.status).toBe("allowed");
    expect(r.audience).toBe("internal");
  });
});

describe("cache keeps the non-member verdict", () => {
  test("a guest verdict is cached: no second users.info within the TTL, and it is never re-derived as internal", async () => {
    userFlags = { is_restricted: true };
    expect((await resolveAudience(ctx("U0GUESTC01"))).audience).not.toBe("internal");
    // Even if Slack would now answer "full member", the cached guest verdict stands (stricter).
    userFlags = {};
    expect((await resolveAudience(ctx("U0GUESTC01"))).audience).not.toBe("internal");
    expect(calls.filter((c) => c.user === "U0GUESTC01").length).toBe(1);
    expect(slackUserTeamCacheKeysForTests().some((k) => k.includes("U0GUESTC01"))).toBe(true);
  });

  test("tenant isolation: org A's guest verdict never serves org C (C asks Slack with its own token)", async () => {
    userFlags = { is_restricted: true };
    await fetchVerifiedSlackUserTeamId(ORG, "U0GUESTC02");
    userFlags = {};
    expect(await fetchVerifiedSlackUserTeamId(ORG_C, "U0GUESTC02")).toBe(OWN);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer xoxb-guest-a", "Bearer xoxb-guest-c"]);
  });
});
