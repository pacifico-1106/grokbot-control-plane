/**
 * P0 User-token channel mention ingress tests.
 * @see docs/p0-user-mention-ingress-design-20260919.md
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isUserChannelMentionIngressEnabled,
  isUserTokenChannelEvent,
  extractUserTokenAuth,
  isConnectEvent,
  isSelfLoop,
  buildUserChannelWakeAudit,
} from "./user-channel-ingress";

describe("P0 User-token channel mention ingress", () => {
  describe("isUserChannelMentionIngressEnabled", () => {
    const savedFlag = process.env.P0_USER_CHANNEL_MENTION_INGRESS;

    afterEach(() => {
      if (savedFlag === undefined) {
        delete process.env.P0_USER_CHANNEL_MENTION_INGRESS;
      } else {
        process.env.P0_USER_CHANNEL_MENTION_INGRESS = savedFlag;
      }
    });

    test("returns false when flag is unset (default OFF)", () => {
      delete process.env.P0_USER_CHANNEL_MENTION_INGRESS;
      expect(isUserChannelMentionIngressEnabled()).toBe(false);
    });

    test("returns false when flag is empty string", () => {
      process.env.P0_USER_CHANNEL_MENTION_INGRESS = "";
      expect(isUserChannelMentionIngressEnabled()).toBe(false);
    });

    test("returns false when flag is 0", () => {
      process.env.P0_USER_CHANNEL_MENTION_INGRESS = "0";
      expect(isUserChannelMentionIngressEnabled()).toBe(false);
    });

    test("returns true when flag is 1", () => {
      process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
      expect(isUserChannelMentionIngressEnabled()).toBe(true);
    });

    test("returns false for any other value", () => {
      process.env.P0_USER_CHANNEL_MENTION_INGRESS = "true";
      expect(isUserChannelMentionIngressEnabled()).toBe(false);
    });
  });

  describe("isUserTokenChannelEvent", () => {
    test("returns true for user-token message event in channel", () => {
      const envelope = {
        event: { type: "message", channel_type: "channel" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(true);
    });

    test("returns true for user-token message event in group (private channel)", () => {
      const envelope = {
        event: { type: "message", channel_type: "group" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(true);
    });

    test("returns false for user-token message event in IM (DM)", () => {
      const envelope = {
        event: { type: "message", channel_type: "im" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns false for bot-token event", () => {
      const envelope = {
        event: { type: "message", channel_type: "channel" },
        authorizations: [{ is_bot: true, user_id: "B123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns false for app_mention event", () => {
      const envelope = {
        event: { type: "app_mention", channel_type: "channel" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns false when event is missing", () => {
      const envelope = {
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns false when authorizations is missing", () => {
      const envelope = {
        event: { type: "message", channel_type: "channel" },
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns false when authorizations is empty", () => {
      const envelope = {
        event: { type: "message", channel_type: "channel" },
        authorizations: [],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns true when mixed authorizations (user + bot)", () => {
      const envelope = {
        event: { type: "message", channel_type: "channel" },
        authorizations: [
          { is_bot: true, user_id: "B123", team_id: "T123" },
          { is_bot: false, user_id: "U123", team_id: "T123" },
        ],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(true);
    });

    test("returns false for D-prefixed channel even without channel_type (DM heuristic)", () => {
      const envelope = {
        event: { type: "message", channel: "D0ABC123XYZ" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(false);
    });

    test("returns true for C-prefixed channel without channel_type", () => {
      const envelope = {
        event: { type: "message", channel: "C0ABC123XYZ" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(true);
    });

    test("returns true for G-prefixed channel (private) without channel_type", () => {
      const envelope = {
        event: { type: "message", channel: "G0ABC123XYZ" },
        authorizations: [{ is_bot: false, user_id: "U123", team_id: "T123" }],
      };
      expect(isUserTokenChannelEvent(envelope)).toBe(true);
    });
  });

  describe("extractUserTokenAuth", () => {
    test("extracts user token from authorizations", () => {
      const envelope = {
        authorizations: [{ is_bot: false, user_id: "U_TANDO", team_id: "T_YASAKA" }],
      };
      const auth = extractUserTokenAuth(envelope);
      expect(auth).toEqual({ userId: "U_TANDO", teamId: "T_YASAKA" });
    });

    test("returns null for bot token", () => {
      const envelope = {
        authorizations: [{ is_bot: true, user_id: "B123", team_id: "T123" }],
      };
      expect(extractUserTokenAuth(envelope)).toBeNull();
    });

    test("returns null when authorizations is missing", () => {
      const envelope = {};
      expect(extractUserTokenAuth(envelope)).toBeNull();
    });

    test("returns first user token when mixed", () => {
      const envelope = {
        authorizations: [
          { is_bot: true, user_id: "B123", team_id: "T123" },
          { is_bot: false, user_id: "U_FIRST", team_id: "T_FIRST" },
          { is_bot: false, user_id: "U_SECOND", team_id: "T_SECOND" },
        ],
      };
      const auth = extractUserTokenAuth(envelope);
      expect(auth).toEqual({ userId: "U_FIRST", teamId: "T_FIRST" });
    });

    test("returns null when user_id is missing", () => {
      const envelope = {
        authorizations: [{ is_bot: false, team_id: "T123" }],
      };
      expect(extractUserTokenAuth(envelope)).toBeNull();
    });

    test("returns null when team_id is missing", () => {
      const envelope = {
        authorizations: [{ is_bot: false, user_id: "U123" }],
      };
      expect(extractUserTokenAuth(envelope)).toBeNull();
    });
  });

  describe("isConnectEvent", () => {
    test("returns true when team IDs are different (Connect channel)", () => {
      expect(isConnectEvent("T_STABLO", "T_YASAKA")).toBe(true);
    });

    test("returns false when team IDs are the same (internal channel)", () => {
      expect(isConnectEvent("T_YASAKA", "T_YASAKA")).toBe(false);
    });

    test("returns false when team IDs differ only in case", () => {
      expect(isConnectEvent("t_yasaka", "T_YASAKA")).toBe(false);
    });

    test("returns false when speakerTeamId is empty", () => {
      expect(isConnectEvent("", "T_YASAKA")).toBe(false);
    });

    test("returns false when subscriberTeamId is empty", () => {
      expect(isConnectEvent("T_YASAKA", "")).toBe(false);
    });
  });

  describe("isSelfLoop", () => {
    test("returns true when speaker is the subscriber (self-loop)", () => {
      expect(isSelfLoop("U_TANDO", "U_TANDO")).toBe(true);
    });

    test("returns true when IDs differ only in case", () => {
      expect(isSelfLoop("u_tando", "U_TANDO")).toBe(true);
    });

    test("returns false when IDs are different", () => {
      expect(isSelfLoop("U_UEHARA", "U_TANDO")).toBe(false);
    });

    test("returns false when speakerId is empty", () => {
      expect(isSelfLoop("", "U_TANDO")).toBe(false);
    });

    test("returns false when subscriberId is empty", () => {
      expect(isSelfLoop("U_TANDO", "")).toBe(false);
    });
  });

  describe("buildUserChannelWakeAudit", () => {
    test("builds complete audit payload for wake", () => {
      const audit = buildUserChannelWakeAudit({
        tokenSubject: { slackUserId: "U_TANDO", slackTeamId: "T_YASAKA" },
        channelId: "C_CONNECT",
        channelClassification: "shared_external",
        isShared: true,
        employeeId: "emp_tando",
        orgId: "org_mirai",
        eventId: "Ev_123",
        eventType: "message.channels",
        speakerId: "U_UEHARA",
        speakerTeamId: "T_STABLO",
        mentionedIds: ["U_TANDO"],
        timestamp: "1726699999.000001",
        woke: true,
      });

      expect(audit.tokenSubject.slackUserId).toBe("U_TANDO");
      expect(audit.tokenSubject.slackTeamId).toBe("T_YASAKA");
      expect(audit.channel.channelId).toBe("C_CONNECT");
      expect(audit.channel.channelClassification).toBe("shared_external");
      expect(audit.channel.isShared).toBe(true);
      expect(audit.employee.employeeId).toBe("emp_tando");
      expect(audit.employee.orgId).toBe("org_mirai");
      expect(audit.event.eventId).toBe("Ev_123");
      expect(audit.event.eventType).toBe("message.channels");
      expect(audit.event.speakerId).toBe("U_UEHARA");
      expect(audit.event.speakerTeamId).toBe("T_STABLO");
      expect(audit.event.mentionedIds).toEqual(["U_TANDO"]);
      expect(audit.event.timestamp).toBe("1726699999.000001");
      expect(audit.outcome.woke).toBe(true);
      expect(audit.outcome.skipReason).toBeUndefined();
    });

    test("builds complete audit payload for skip", () => {
      const audit = buildUserChannelWakeAudit({
        tokenSubject: { slackUserId: "U_TANDO", slackTeamId: "T_YASAKA" },
        channelId: "C_UNKNOWN",
        channelClassification: "unknown",
        isShared: false,
        employeeId: "",
        orgId: "",
        eventId: "Ev_456",
        eventType: "message.channels",
        speakerId: "U_UEHARA",
        speakerTeamId: "T_STABLO",
        mentionedIds: ["U_TANDO"],
        timestamp: "1726699999.000002",
        woke: false,
        skipReason: "channel_not_classified",
      });

      expect(audit.outcome.woke).toBe(false);
      expect(audit.outcome.skipReason).toBe("channel_not_classified");
    });
  });
});
