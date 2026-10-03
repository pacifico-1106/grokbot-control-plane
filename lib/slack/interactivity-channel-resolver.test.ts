/**
 * Tests for Slack interactivity channel resolver.
 * P0 Item 3: Single Slack interactivity endpoint with bounded signature verification.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

const {
  findChannelCandidatesByAppAndTeam,
  setDemoInteractivityChannel,
  resetDemoInteractivityChannels,
} = await import("./interactivity-channel-resolver");

const DEMO_ORG_ID = "org-test-123";
const DEMO_CHANNEL_ID = "channel-test-456";
const DEMO_API_APP_ID = "A0123456789";
const DEMO_TEAM_ID = "T0123456789";
const OTHER_TEAM_ID = "T9876543210";

describe("interactivity channel resolver", () => {
  beforeEach(() => {
    resetDemoInteractivityChannels();
  });

  test("finds channel by matching api_app_id and team_id", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
        allowedUserIds: ["U123"],
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe(DEMO_CHANNEL_ID);
    expect(candidates[0].apiAppId).toBe(DEMO_API_APP_ID);
    expect(candidates[0].teamId).toBe(DEMO_TEAM_ID);
    expect(candidates[0].signingSecret).toBe("test-secret");
  });

  test("finds channel by expectedTeamId when teamId not set", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        expectedTeamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates.length).toBe(1);
    expect(candidates[0].expectedTeamId).toBe(DEMO_TEAM_ID);
  });

  test("rejects wrong team_id (cross-org isolation)", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      OTHER_TEAM_ID
    );

    expect(candidates.length).toBe(0);
  });

  test("rejects wrong api_app_id", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      "A_WRONG_APP",
      DEMO_TEAM_ID
    );

    expect(candidates.length).toBe(0);
  });

  test("returns empty for empty input", async () => {
    const candidates1 = await findChannelCandidatesByAppAndTeam("", DEMO_TEAM_ID);
    const candidates2 = await findChannelCandidatesByAppAndTeam(DEMO_API_APP_ID, "");

    expect(candidates1.length).toBe(0);
    expect(candidates2.length).toBe(0);
  });

  test("finds channel without explicit apiAppId (wildcard match)", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates.length).toBe(1);
    expect(candidates[0].apiAppId).toBe(DEMO_API_APP_ID);
  });

  test("returns multiple candidates for same app/team", async () => {
    setDemoInteractivityChannel({
      id: "channel-1",
      orgId: "org-1",
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-1",
        signingSecret: "secret-1",
      },
    });

    setDemoInteractivityChannel({
      id: "channel-2",
      orgId: "org-2",
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-2",
        signingSecret: "secret-2",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates.length).toBe(2);
    const secrets = candidates.map((c) => c.signingSecret).sort();
    expect(secrets).toEqual(["secret-1", "secret-2"]);
  });

  test("preserves allowedUserIds from config", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
        allowedUserIds: ["U123", "U456"],
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates[0].allowedUserIds).toEqual(["U123", "U456"]);
  });
});

describe("replay protection", () => {
  beforeEach(() => {
    resetDemoInteractivityChannels();
  });

  test("channel candidate includes orgId for cross-org ticket isolation", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: {
        apiAppId: DEMO_API_APP_ID,
        teamId: DEMO_TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-test",
        signingSecret: "test-secret",
      },
    });

    const candidates = await findChannelCandidatesByAppAndTeam(
      DEMO_API_APP_ID,
      DEMO_TEAM_ID
    );

    expect(candidates[0].orgId).toBe(DEMO_ORG_ID);
  });

  test("rejects ids that could inject PostgREST filter syntax", async () => {
    setDemoInteractivityChannel({
      id: DEMO_CHANNEL_ID,
      orgId: DEMO_ORG_ID,
      provider: "slack",
      config: { apiAppId: DEMO_API_APP_ID, teamId: DEMO_TEAM_ID },
      secrets: { botToken: "xoxb-test", signingSecret: "test-secret" },
    });
    expect(
      await findChannelCandidatesByAppAndTeam(`${DEMO_API_APP_ID},id.not.is.null`, DEMO_TEAM_ID)
    ).toEqual([]);
    expect(
      await findChannelCandidatesByAppAndTeam(DEMO_API_APP_ID, `${DEMO_TEAM_ID})`)
    ).toEqual([]);
  });

  test("supabase filter compares jsonb keys as text (->>), not jsonb (->)", async () => {
    const source = await Bun.file(
      new URL("./interactivity-channel-resolver.ts", import.meta.url)
    ).text();
    expect(source).not.toMatch(/config->(apiAppId|teamId|expectedTeamId)\./);
    expect(source).toContain("config->>apiAppId.eq.");
    expect(source).toContain("config->>teamId.eq.");
  });
});
