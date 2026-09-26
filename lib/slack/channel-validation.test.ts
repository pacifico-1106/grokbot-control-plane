/**
 * P0 Item 5: Slack channel validation tests.
 *
 * Includes tenant-agnostic invariant tests:
 * - Slack Connect / externally shared channels can never be registered as approval channels
 * - Cross-org Slack user isolation
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  validateSlackChannelNotExternal,
  isSlackUserFromExpectedTeam,
} from "./channel-validation";

const makeMockFetch = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve({
      status,
      json: () => Promise.resolve(body),
    })) as typeof fetch;

describe("validateSlackChannelNotExternal", () => {
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  test("rejects missing credentials", async () => {
    const result = await validateSlackChannelNotExternal("", "C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_credentials");
    }
  });

  test("rejects Slack Connect channels (is_ext_shared)", async () => {
    globalThis.fetch = makeMockFetch({
      ok: true,
      channel: {
        id: "C123",
        name: "ext-channel",
        is_ext_shared: true,
      },
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("slack_connect_channel");
    }
  });

  test("rejects externally shared channels (is_shared)", async () => {
    globalThis.fetch = makeMockFetch({
      ok: true,
      channel: {
        id: "C123",
        name: "shared-channel",
        is_shared: true,
      },
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("shared_channel");
    }
  });

  test("rejects pending external share channels", async () => {
    globalThis.fetch = makeMockFetch({
      ok: true,
      channel: {
        id: "C123",
        name: "pending-channel",
        is_pending_ext_shared: true,
      },
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pending_external_share");
    }
  });

  test("accepts normal internal channels", async () => {
    globalThis.fetch = makeMockFetch({
      ok: true,
      channel: {
        id: "C123",
        name: "internal-channel",
        is_channel: true,
        is_private: false,
        is_shared: false,
        is_ext_shared: false,
      },
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channelId).toBe("C123");
      expect(result.name).toBe("internal-channel");
    }
  });

  test("handles Slack API errors", async () => {
    globalThis.fetch = makeMockFetch({
      ok: false,
      error: "channel_not_found",
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C999");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("slack_api_error");
      expect(result.reason).toBe("channel_not_found");
    }
  });

  test("handles network errors (fail-closed)", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("Network error"))) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
    }
  });
});

describe("isSlackUserFromExpectedTeam", () => {
  test("allows when no team check configured", () => {
    const result = isSlackUserFromExpectedTeam("T123", undefined);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_team_check_configured");
  });

  test("allows when user team matches expected team", () => {
    const result = isSlackUserFromExpectedTeam("T123", "T123");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("same_team");
  });

  test("rejects when user team_id is missing", () => {
    const result = isSlackUserFromExpectedTeam(undefined, "T123");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_team_id_missing");
  });

  test("rejects when user is from different team", () => {
    const result = isSlackUserFromExpectedTeam("T456", "T123");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("external_team_user");
  });
});

/**
 * Tenant-agnostic invariant tests.
 * These tests must pass for any org fixture and verify security invariants.
 */
describe("INVARIANT: Slack Connect channels can never be registered as approval channels", () => {
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  const EXTERNAL_CHANNEL_FIXTURES = [
    {
      name: "Slack Connect channel (is_ext_shared)",
      channel: { id: "C_CONNECT", name: "connect-channel", is_ext_shared: true },
      expectedCode: "slack_connect_channel",
    },
    {
      name: "Shared channel (is_shared)",
      channel: { id: "C_SHARED", name: "shared-channel", is_shared: true },
      expectedCode: "shared_channel",
    },
    {
      name: "Pending external share (is_pending_ext_shared)",
      channel: { id: "C_PENDING", name: "pending-channel", is_pending_ext_shared: true },
      expectedCode: "pending_external_share",
    },
    {
      name: "Both is_ext_shared and is_shared",
      channel: { id: "C_BOTH", name: "dual-channel", is_ext_shared: true, is_shared: true },
      expectedCode: "slack_connect_channel",
    },
  ];

  for (const fixture of EXTERNAL_CHANNEL_FIXTURES) {
    test(`INVARIANT: ${fixture.name} is rejected`, async () => {
      globalThis.fetch = makeMockFetch({
        ok: true,
        channel: fixture.channel,
      }) as typeof fetch;

      const result = await validateSlackChannelNotExternal("xoxb-test", fixture.channel.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(fixture.expectedCode);
      }
    });
  }

  test("INVARIANT: internal channel is accepted", async () => {
    globalThis.fetch = makeMockFetch({
      ok: true,
      channel: {
        id: "C_INTERNAL",
        name: "internal-channel",
        is_channel: true,
        is_shared: false,
        is_ext_shared: false,
        is_pending_ext_shared: false,
      },
    }) as typeof fetch;

    const result = await validateSlackChannelNotExternal("xoxb-test", "C_INTERNAL");
    expect(result.ok).toBe(true);
  });
});

describe("INVARIANT: Cross-org Slack user isolation", () => {
  const ORG_A_TEAM = "T_ORG_A";
  const ORG_B_TEAM = "T_ORG_B";

  test("INVARIANT: user from org B team cannot pass org A team check", () => {
    const result = isSlackUserFromExpectedTeam(ORG_B_TEAM, ORG_A_TEAM);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("external_team_user");
  });

  test("INVARIANT: user with missing team_id is rejected (fail-closed)", () => {
    const result = isSlackUserFromExpectedTeam(undefined, ORG_A_TEAM);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_team_id_missing");
  });

  test("INVARIANT: same team user is allowed", () => {
    const result = isSlackUserFromExpectedTeam(ORG_A_TEAM, ORG_A_TEAM);
    expect(result.allowed).toBe(true);
  });
});
