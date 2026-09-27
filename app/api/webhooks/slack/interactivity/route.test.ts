/**
 * Tests for Slack interactivity route.
 * PR #129 audit fix: ambiguous secret detection
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

const {
  setDemoInteractivityChannel,
  resetDemoInteractivityChannels,
} = await import("@/lib/slack/interactivity-channel-resolver");

function makeSlackSignature(rawBody: string, timestamp: string, signingSecret: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const signature = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return `v0=${signature}`;
}

describe("slack interactivity route security", () => {
  beforeEach(() => {
    resetDemoInteractivityChannels();
  });

  test("ambiguous secret detection logs and rejects when multiple candidates match", async () => {
    const API_APP_ID = "A0123456789";
    const TEAM_ID = "T0123456789";
    const SHARED_SECRET = "shared-secret-value";
    const timestamp = String(Math.floor(Date.now() / 1000));

    setDemoInteractivityChannel({
      id: "channel-org-a",
      orgId: "org-a",
      provider: "slack",
      config: {
        apiAppId: API_APP_ID,
        teamId: TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-a",
        signingSecret: SHARED_SECRET,
      },
    });

    setDemoInteractivityChannel({
      id: "channel-org-b",
      orgId: "org-b",
      provider: "slack",
      config: {
        apiAppId: API_APP_ID,
        teamId: TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-b",
        signingSecret: SHARED_SECRET,
      },
    });

    const payload = {
      type: "block_actions",
      api_app_id: API_APP_ID,
      team: { id: TEAM_ID },
      user: { id: "U123", team_id: TEAM_ID },
      actions: [{ action_id: "staffpass_approve", value: "test-value" }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const signature = makeSlackSignature(rawBody, timestamp, SHARED_SECRET);

    const { POST } = await import("./route");
    const request = new Request("https://test.com/api/webhooks/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
  });

  test("accepts when only one candidate matches signature", async () => {
    const API_APP_ID = "A0123456789";
    const TEAM_ID = "T0123456789";
    const SECRET_A = "secret-a";
    const SECRET_B = "secret-b";
    const timestamp = String(Math.floor(Date.now() / 1000));

    setDemoInteractivityChannel({
      id: "channel-org-a",
      orgId: "org-a",
      provider: "slack",
      config: {
        apiAppId: API_APP_ID,
        teamId: TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-a",
        signingSecret: SECRET_A,
      },
    });

    setDemoInteractivityChannel({
      id: "channel-org-b",
      orgId: "org-b",
      provider: "slack",
      config: {
        apiAppId: API_APP_ID,
        teamId: TEAM_ID,
      },
      secrets: {
        botToken: "xoxb-b",
        signingSecret: SECRET_B,
      },
    });

    const payload = {
      type: "block_actions",
      api_app_id: API_APP_ID,
      team: { id: TEAM_ID },
      user: { id: "U123", team_id: TEAM_ID },
      actions: [{ action_id: "staffpass_approve", value: "test-value" }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const signature = makeSlackSignature(rawBody, timestamp, SECRET_A);

    const { POST } = await import("./route");
    const request = new Request("https://test.com/api/webhooks/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });
});
