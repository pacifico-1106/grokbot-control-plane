import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  parseConversationContext,
  resolveAudience,
  resolveConversationThreadId,
  resolveParentMessageTs,
} from "@/lib/gateway/audience";
import {
  clearDemoRule,
  setOrgInternalAudienceRule,
} from "@/lib/data/internal-audience-rule";
import type { GatewayInvokeRequest } from "@/lib/types";

function body(partial: Partial<GatewayInvokeRequest>): GatewayInvokeRequest {
  return {
    tool: "comm.send",
    purpose: "comm.internal",
    jobId: "job_audience",
    ...partial,
  };
}

/**
 * S1 Dual-Audience Tests
 * Mixed / Slack Connect / shared_external channels need per-party resolution.
 */
describe("S1 dual-audience for mixed channels", () => {
  test("mixed channel + internal party → dual has internal facing, overall external", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_YAMADA",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.dualAudience).not.toBeNull();
    expect(resolved.dualAudience?.channelMixed).toBe(true);
    expect(resolved.dualAudience?.hasInternalParty).toBe(true);
    expect(resolved.dualAudience?.hasExternalParty).toBe(false);
    expect(resolved.dualAudience?.internalFacing).toBe("internal");
    expect(resolved.dualAudience?.externalFacing).toBe("internal");
  });

  test("mixed channel + external party → dual has external facing", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "someone@customer.example",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.dualAudience?.hasExternalParty).toBe(true);
    expect(resolved.dualAudience?.externalFacing).toBe("external");
  });

  test("mixed channel + internal + unknown party → dual has both, external facing", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_UNKNOWN_CONNECT_GUEST",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.dualAudience?.channelMixed).toBe(true);
    expect(resolved.dualAudience?.hasExternalParty).toBe(true);
    const unknownParty = resolved.dualAudience?.partySignals.find(
      (signal) => signal.kind === "slack_user"
    );
    expect(unknownParty?.audience).toBe("unknown");
    expect(unknownParty?.resolved).toBe(false);
    expect(resolved.dualAudience?.externalFacing).toBe("external");
  });

  test("unknown party remains fail-closed external", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackUserId: "U_STRANGER",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.dualAudience?.hasExternalParty).toBe(true);
    expect(resolved.dualAudience?.internalFacing).toBe("external");
    const unknownSignal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "slack_user"
    );
    expect(unknownSignal?.audience).toBe("unknown");
    expect(unknownSignal?.resolved).toBe(false);
  });

  test("pure internal channel keeps current behavior (no dual-audience activation)", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.audience).toBe("internal");
    expect(resolved.effectiveAudience).toBe("internal");
    expect(resolved.dualAudience?.channelMixed).toBe(false);
  });

  test("partySignals include per-party resolution detail", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_YAMADA",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.dualAudience?.partySignals.length).toBeGreaterThan(0);
    const yamadaSignal = resolved.dualAudience?.partySignals.find(
      (signal) => signal.identifier === "U_YAMADA"
    );
    expect(yamadaSignal?.kind).toBe("slack_user");
    expect(yamadaSignal?.audience).toBe("internal");
    expect(yamadaSignal?.resolved).toBe(true);
  });

  test("internal email domain in mixed context → internal party signal", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "colleague@example.com",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);

    expect(resolved.dualAudience?.hasInternalParty).toBe(true);
    const emailSignal = resolved.dualAudience?.partySignals.find(
      (signal) => signal.kind === "mail_address"
    );
    expect(emailSignal?.audience).toBe("internal");
  });
});

describe("audience resolver", () => {
  test("unknown audience (missing destination) is fail-closed as external", async () => {
    const ctx = parseConversationContext(
      body({ conversation: { surface: "slack", orgId: DEMO_ORG.id } }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx, { requireDestination: true });
    expect(resolved.audience).toBe("unknown");
    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.destinationMissing).toBe(true);
  });

  test("unregistered identifier is unknown → external", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "stranger@unknown-corp.example",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);
    expect(resolved.effectiveAudience).toBe("external");
  });

  test("mixed/shared Slack channel is external for egress", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);
    expect(resolved.effectiveAudience).toBe("external");
    expect(resolved.audience).toBe("external");
  });

  test("classified internal Slack channel stays internal", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);
    expect(resolved.audience).toBe("internal");
    expect(resolved.effectiveAudience).toBe("internal");
    expect(resolved.namedRecipients).toBe(false);
  });

  test("internal domain email is internal and named", async () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "owner@example.com",
        },
      }),
      DEMO_ORG.id
    );
    const resolved = await resolveAudience(ctx);
    expect(resolved.effectiveAudience).toBe("internal");
    expect(resolved.namedRecipients).toBe(true);
  });

  test("slackThreadTs alias maps onto conversation.threadId", () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          slackThreadTs: "1787911797.502889",
        } as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(ctx?.threadId).toBe("1787911797.502889");
  });

  test("thread_ts alias on conversation or args maps onto conversation.threadId", () => {
    const fromConv = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          thread_ts: "1787911797.502889",
        } as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(fromConv?.threadId).toBe("1787911797.502889");

    const fromArgs = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { thread_ts: "1787911800.000001" },
      }),
      DEMO_ORG.id
    );
    expect(fromArgs?.threadId).toBe("1787911800.000001");
  });

  test("args.slackThreadTs is an alias of threadId", () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { slackThreadTs: "1787911797.502889" },
      }),
      DEMO_ORG.id
    );
    expect(ctx?.threadId).toBe("1787911797.502889");
  });

  test("empty thread falls back to mention-source messageTs", () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          messageTs: "1787960001.111111",
        } as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(ctx?.threadId).toBe("1787960001.111111");
  });

  test("threadTs / thread_id / body.threadId aliases and slackTs fallback", () => {
    const fromThreadTs = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          threadTs: "1787911797.502889",
        } as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(fromThreadTs?.threadId).toBe("1787911797.502889");

    const fromArgsThreadId = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { thread_id: "1787911800.000001" },
      }),
      DEMO_ORG.id
    );
    expect(fromArgsThreadId?.threadId).toBe("1787911800.000001");

    const fromBody = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        threadId: "1787911802.000003",
      }),
      DEMO_ORG.id
    );
    expect(fromBody?.threadId).toBe("1787911802.000003");

    const fromSlackTs = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          slackTs: "1787960002.222222",
        } as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(fromSlackTs?.threadId).toBe("1787960002.222222");
  });

  test("existing thread wins over mention-source messageTs", () => {
    const resolved = resolveConversationThreadId({
      conversation: {
        surface: "slack",
        orgId: DEMO_ORG.id,
        slackChannelId: "C_INTERNAL",
        thread_ts: "1787911797.502889",
        messageTs: "1787960001.111111",
      },
    });
    expect(resolved).toBe("1787911797.502889");
  });

  test("wake ts preserved on context when thread_ts is null (production wake shape)", () => {
    const wakeTs = "1787960001.111111";
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          ts: wakeTs,
          thread_ts: null,
        } as unknown as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    expect(ctx?.ts).toBe(wakeTs);
    expect(ctx?.threadId).toBeUndefined();
  });

  test("wake ts in args preserved on context when conversation has no ts", () => {
    const wakeTs = "1787960001.111111";
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        args: { ts: wakeTs },
      }),
      DEMO_ORG.id
    );
    expect(ctx?.ts).toBe(wakeTs);
    expect(ctx?.threadId).toBeUndefined();
  });

  test("resolveParentMessageTs finds ts from conversation context", () => {
    const wakeTs = "1787960001.111111";
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          ts: wakeTs,
          thread_ts: null,
        } as unknown as GatewayInvokeRequest["conversation"],
      }),
      DEMO_ORG.id
    );
    const parentTs = resolveParentMessageTs({ conversation: ctx, args: {} });
    expect(parentTs).toBe(wakeTs);
  });

  test("resolveParentMessageTs finds ts from args when conversation.ts missing", () => {
    const wakeTs = "1787960001.111111";
    const parentTs = resolveParentMessageTs({
      conversation: { surface: "slack", slackChannelId: "C_INTERNAL" },
      args: { ts: wakeTs },
    });
    expect(parentTs).toBe(wakeTs);
  });

  test("resolveParentMessageTs prefers ts over messageTs/slackTs", () => {
    const ts = "1787960001.111111";
    const messageTs = "1787960002.222222";
    const parentTs = resolveParentMessageTs({
      conversation: { ts, messageTs },
      args: {},
    });
    expect(parentTs).toBe(ts);
  });

  test("ts at body root level is extracted (Bot sends body.ts)", () => {
    const wakeTs = "1787960001.111111";
    const ctx = parseConversationContext(
      {
        tool: "comm.send",
        purpose: "comm.internal",
        jobId: "job_body_ts",
        ts: wakeTs,
        conversation: {
          surface: "slack",
          slackChannelId: "C_INTERNAL",
        },
      } as unknown as GatewayInvokeRequest,
      DEMO_ORG.id
    );
    expect(ctx?.ts).toBe(wakeTs);
    expect(ctx?.threadId).toBeUndefined();
  });
});

/**
 * Org internal audience rule tests (stablo-scale channels).
 * Internal = parties allowlist UNION emailDomains UNION slackTeamIds.
 * Connect guests / unregistered → external (fail-closed).
 * Example: #stablo_tokyo307 Connect channel.
 */
describe("org internal audience rule (stablo-scale)", () => {
  afterEach(() => {
    clearDemoRule();
  });

  test("autoSlackTeamInternal=true + matching slackTeamId → internal", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        slackTeamIds: ["TSTABLO307"],
        autoSlackTeamInternal: true,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_STABLO_MEMBER",
        },
        args: { slackTeamId: "TSTABLO307" },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    expect(resolved.internalAudienceRule?.autoSlackTeamInternal).toBe(true);
    expect(resolved.dualAudience?.hasInternalParty).toBe(true);
    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "slack_user"
    );
    expect(signal?.audience).toBe("internal");
    expect(signal?.resolved).toBe(true);
  });

  test("autoSlackTeamInternal=true + different slackTeamId → external (Connect guest)", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        slackTeamIds: ["TSTABLO307"],
        autoSlackTeamInternal: true,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_EXTERNAL_GUEST",
        },
        args: { slackTeamId: "T_EXTERNAL_TEAM" },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    expect(resolved.dualAudience?.hasExternalParty).toBe(true);
    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "slack_user"
    );
    expect(signal?.audience).toBe("unknown");
    expect(signal?.resolved).toBe(false);
  });

  test("autoSlackTeamInternal=false → no auto-internal even with matching team", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        slackTeamIds: ["TSTABLO307"],
        autoSlackTeamInternal: false,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackUserId: "U_STABLO_MEMBER",
        },
        args: { slackTeamId: "TSTABLO307" },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "slack_user"
    );
    expect(signal?.audience).toBe("unknown");
    expect(signal?.resolved).toBe(false);
  });

  test("emailDomains rule → matching domain is internal", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        emailDomains: ["stablo-internal.example"],
        autoSlackTeamInternal: false,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "employee@stablo-internal.example",
        },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    expect(resolved.dualAudience?.hasInternalParty).toBe(true);
    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "mail_address"
    );
    expect(signal?.audience).toBe("internal");
    expect(signal?.resolved).toBe(true);
  });

  test("emailDomains rule → non-matching domain is external", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        emailDomains: ["stablo-internal.example"],
        autoSlackTeamInternal: false,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "mail",
          orgId: DEMO_ORG.id,
          email: "customer@external-corp.example",
        },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    expect(resolved.dualAudience?.hasExternalParty).toBe(true);
    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "mail_address"
    );
    expect(signal?.audience).toBe("unknown");
    expect(signal?.resolved).toBe(false);
  });

  test("parties.upsert takes precedence over org rule", async () => {
    await setOrgInternalAudienceRule(
      DEMO_ORG.id,
      {
        slackTeamIds: ["TSTABLO307"],
        autoSlackTeamInternal: true,
      },
      "test@example.com"
    );

    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_SHARED",
          slackUserId: "U_YAMADA",
        },
        args: { slackTeamId: "T_EXTERNAL" },
      }),
      DEMO_ORG.id
    );

    const resolved = await resolveAudience(ctx);

    const signal = resolved.dualAudience?.partySignals.find(
      (s) => s.kind === "slack_user"
    );
    expect(signal?.audience).toBe("internal");
    expect(signal?.resolved).toBe(true);
  });

  test("slackTeamId parses from args.teamId alias", () => {
    const ctx = parseConversationContext(
      body({
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackUserId: "U_MEMBER",
        },
        args: { teamId: "T_FROM_ALIAS" },
      }),
      DEMO_ORG.id
    );

    expect(ctx?.slackTeamId).toBe("T_FROM_ALIAS");
  });
});
