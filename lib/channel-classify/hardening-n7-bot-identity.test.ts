/**
 * Follow-up to PR-B (N7): a Slack join event only counts when it was delivered
 * for the org's OWN conversation bot: envelope api_app_id == the adapter bot's
 * app, the bot authorization == the adapter bot user, team matches. Unknown
 * identity → nothing (fail-closed). The shared approval app never counts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { setJoinDepsForTests, slackJoinSignals, resolveAdapterBotIdentity, resetAdapterBotIdentityCacheForTests } from "@/lib/channel-classify/join";
import { setChannelFactsDepsForTests, type SlackApi } from "@/lib/channel-classify/facts";

const ORG = DEMO_ORG.id;
const TEAM = "T0HOMETEAM";
const APP = "A0ORGBOTAPP";
const BOT = "U0APPBOT";

function envelope(over: Record<string, unknown> = {}, user = "U0EMPLOYEE") {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: APP,
    authorizations: [{ team_id: TEAM, user_id: BOT, is_bot: true }],
    event: { type: "member_joined_channel", user, channel: "C0N7CHAN01", channel_type: "C", team: TEAM },
    ...over,
  };
}

beforeEach(() => {
  delete process.env.SLACK_SHARED_APPROVAL_APP_ID;
  setJoinDepsForTests({
    findEmployeeOrgsBySlackUser: async (userId, teamId) => (userId === "U0EMPLOYEE" && teamId === TEAM ? [{ orgId: ORG, employeeId: "emp" }] : []),
    findOrgsBySlackTeam: async (teamId) => (teamId === TEAM ? [ORG] : []),
    adapterBotIdentity: async (orgId) => (orgId === ORG ? { appId: APP, botUserId: BOT, teamId: TEAM } : null),
  });
});

afterEach(() => {
  delete process.env.SLACK_SHARED_APPROVAL_APP_ID;
  setJoinDepsForTests(null);
  setChannelFactsDepsForTests(null);
  resetAdapterBotIdentityCacheForTests();
});

describe("N7 Slack join: api_app_id / bot must be the adapter's bot", () => {
  test("matching app + bot → signal (employee join and own-bot join)", async () => {
    expect((await slackJoinSignals(envelope())).map((s) => s.orgId)).toEqual([ORG]);
    expect((await slackJoinSignals(envelope({}, BOT))).map((s) => s.orgId)).toEqual([ORG]);
  });

  test("api_app_id of another app → nothing", async () => {
    expect(await slackJoinSignals(envelope({ api_app_id: "A0SOMEOTHER" }))).toEqual([]);
  });

  test("missing api_app_id → nothing", async () => {
    const env = envelope();
    delete (env as Record<string, unknown>).api_app_id;
    expect(await slackJoinSignals(env)).toEqual([]);
  });

  test("bot authorization is a different bot → nothing (both paths)", async () => {
    const other = { authorizations: [{ team_id: TEAM, user_id: "U0OTHERBOT", is_bot: true }] };
    expect(await slackJoinSignals(envelope(other))).toEqual([]);
    expect(await slackJoinSignals(envelope(other, "U0OTHERBOT"))).toEqual([]);
  });

  test("adapter identity unknown (no token / auth.test failed) → nothing", async () => {
    setJoinDepsForTests({
      findEmployeeOrgsBySlackUser: async () => [{ orgId: ORG, employeeId: "emp" }],
      findOrgsBySlackTeam: async () => [ORG],
      adapterBotIdentity: async () => null,
    });
    expect(await slackJoinSignals(envelope())).toEqual([]);
  });

  test("adapter team differs from the event team → nothing", async () => {
    setJoinDepsForTests({
      findEmployeeOrgsBySlackUser: async () => [{ orgId: ORG, employeeId: "emp" }],
      findOrgsBySlackTeam: async () => [ORG],
      adapterBotIdentity: async () => ({ appId: APP, botUserId: BOT, teamId: "T0ELSEWHERE" }),
    });
    expect(await slackJoinSignals(envelope())).toEqual([]);
  });

  test("the shared approval app's id never counts, even if it matched", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ID = APP;
    expect(await slackJoinSignals(envelope())).toEqual([]);
  });

  test("resolveAdapterBotIdentity: auth.test → bots.info with the org's own token; cached; failures → null", async () => {
    const seen: Array<{ method: string; token: string }> = [];
    const fake: SlackApi = async (method, params, token) => {
      seen.push({ method, token });
      if (method === "auth.test") return { ok: true, team_id: TEAM, user_id: BOT, bot_id: "B0ORGBOT" };
      if (method === "bots.info") return params.bot === "B0ORGBOT" ? { ok: true, bot: { id: "B0ORGBOT", app_id: APP, user_id: BOT } } : { ok: false };
      return { ok: false };
    };
    setChannelFactsDepsForTests({ slackApi: fake, resolveToken: async (orgId) => (orgId === ORG ? "xoxb-org-own" : "") });
    expect(await resolveAdapterBotIdentity(ORG)).toEqual({ appId: APP, botUserId: BOT, teamId: TEAM });
    expect(await resolveAdapterBotIdentity(ORG)).toEqual({ appId: APP, botUserId: BOT, teamId: TEAM });
    expect(seen.filter((s) => s.method === "auth.test").length).toBe(1);
    expect(seen.every((s) => s.token === "xoxb-org-own")).toBe(true);
    expect(await resolveAdapterBotIdentity("org_without_token")).toBeNull();
  });
});
