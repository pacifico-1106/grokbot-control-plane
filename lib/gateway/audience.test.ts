import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  parseConversationContext,
  resolveAudience,
  resolveConversationThreadId,
} from "@/lib/gateway/audience";
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
});
