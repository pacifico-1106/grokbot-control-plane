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
