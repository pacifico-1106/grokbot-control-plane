/**
 * 木村 10/10: `channel_joined` / `group_joined` are RTM-only (no Events API
 * subscription). `member_joined_channel` is subscribed as a bot event AND as a
 * user event. A user-subscription delivery carries only a user authorization
 * (is_bot false); Slack lists ONE installation the event is visible to, which
 * may be a user even when the bot is also subscribed. It must get the same
 * treatment as the bot delivery, and tenant isolation must hold: team, app and
 * employee / bot binding all match, otherwise nothing (fail closed).
 * Dummy ids only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetAdapterBotIdentityCacheForTests, setJoinDepsForTests, slackJoinSignals } from "@/lib/channel-classify/join";

const ORG = DEMO_ORG.id;
const ORG_B = "org_join_user_sub_b";
const TEAM = "T0HOMETEAM";
const APP = "A0BU8TABSV6";
const BOT = "U0APPBOT";
const EMP = "U0EMPLOYEE";

function userSubEnvelope(over: Record<string, unknown> = {}, joiner = EMP, authUser = EMP) {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: APP,
    authorizations: [{ team_id: TEAM, user_id: authUser, is_bot: false }],
    event: { type: "member_joined_channel", user: joiner, channel: "C0USERSUB01", channel_type: "C", team: TEAM },
    ...over,
  };
}

function deps(teamOrgs: string[] = [ORG]) {
  setJoinDepsForTests({
    findEmployeeOrgsBySlackUser: async (userId, teamId) => (userId === EMP && teamId === TEAM ? [{ orgId: ORG, employeeId: "emp" }] : []),
    findOrgsBySlackTeam: async (teamId) => (teamId === TEAM ? teamOrgs : []),
    adapterBotIdentity: async (orgId) =>
      orgId === ORG ? { appId: APP, botUserId: BOT, teamId: TEAM } : orgId === ORG_B ? { appId: APP, botUserId: "U0BOTB", teamId: TEAM } : null,
  });
}

beforeEach(() => {
  delete process.env.SLACK_SHARED_APPROVAL_APP_ID;
  deps();
});
afterEach(() => {
  delete process.env.SLACK_SHARED_APPROVAL_APP_ID;
  setJoinDepsForTests(null);
  resetAdapterBotIdentityCacheForTests();
});

describe("member_joined_channel delivered on the USER subscription", () => {
  test("the employee themself joining (event.user = the bound Slack user) → signal for that org", async () => {
    const signals = await slackJoinSignals(userSubEnvelope());
    expect(signals.map((s) => s.orgId)).toEqual([ORG]);
    expect(signals[0]).toMatchObject({ surface: "slack", externalId: "C0USERSUB01", trigger: "slack_member_joined", homeTeamId: TEAM, actorVerified: true });
  });

  test("delivered via another app user's subscription: still keyed on event.user (the joiner), not the authorizing user", async () => {
    expect((await slackJoinSignals(userSubEnvelope({}, EMP, "U0COLLEAGUE"))).map((s) => s.orgId)).toEqual([ORG]);
    expect(await slackJoinSignals(userSubEnvelope({}, "U0STRANGER", EMP))).toEqual([]);
  });

  test("the org's own bot joining, delivered with only a USER authorization → signal (same as the bot delivery)", async () => {
    expect((await slackJoinSignals(userSubEnvelope({}, BOT))).map((s) => s.orgId)).toEqual([ORG]);
  });

  test("own-bot fallback is strict: a bot user that is not the adapter's bot → nothing; ambiguous team → nothing", async () => {
    expect(await slackJoinSignals(userSubEnvelope({}, "U0OTHERBOT"))).toEqual([]);
    deps([ORG, ORG_B]);
    expect(await slackJoinSignals(userSubEnvelope({}, BOT))).toEqual([]);
  });

  test("N7 on the user subscription: another app / the shared approval app / adapter in another team → nothing", async () => {
    expect(await slackJoinSignals(userSubEnvelope({ api_app_id: "A0SOMEOTHER" }))).toEqual([]);
    process.env.SLACK_SHARED_APPROVAL_APP_ID = APP;
    expect(await slackJoinSignals(userSubEnvelope())).toEqual([]);
    delete process.env.SLACK_SHARED_APPROVAL_APP_ID;
    setJoinDepsForTests({
      findEmployeeOrgsBySlackUser: async () => [{ orgId: ORG, employeeId: "emp" }],
      findOrgsBySlackTeam: async () => [ORG],
      adapterBotIdentity: async () => ({ appId: APP, botUserId: BOT, teamId: "T0ELSEWHERE" }),
    });
    expect(await slackJoinSignals(userSubEnvelope())).toEqual([]);
  });

  test("fail closed: an authorization for another team → nothing", async () => {
    const other = { authorizations: [{ team_id: "T0ELSEWHERE", user_id: EMP, is_bot: false }] };
    expect(await slackJoinSignals(userSubEnvelope(other))).toEqual([]);
    expect(await slackJoinSignals(userSubEnvelope(other, BOT))).toEqual([]);
  });

  test("fail closed: no authorizations at all → nothing", async () => {
    expect(await slackJoinSignals(userSubEnvelope({ authorizations: [] }))).toEqual([]);
    const env = userSubEnvelope();
    delete (env as Record<string, unknown>).authorizations;
    expect(await slackJoinSignals(env)).toEqual([]);
  });
});
