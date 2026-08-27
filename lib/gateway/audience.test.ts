import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  parseConversationContext,
  resolveAudience,
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
});
