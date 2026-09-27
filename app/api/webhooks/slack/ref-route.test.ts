/**
 * P0 Item 7: Route-level tests for /api/webhooks/slack/[ref]
 * 
 * Tests:
 * - Bad signature rejected (401)
 * - Stale timestamp (>5min) rejected (401)
 * - Unknown ref returns ack with ignored
 * - Valid request with correct signature is accepted
 * - Valid vote request proceeds to handleBlockActions
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { createHmac } from "node:crypto";

const FIXTURE_SIGNING_SECRET = "test_signing_secret_12345";
const FIXTURE_REF = "test_webhook_ref";
const FIXTURE_CHANNEL_ID = "chn_fixture";
const FIXTURE_ORG_ID = "org_fixture";
const FIXTURE_USER_ID = "U_FIXTURE_USER";
const FIXTURE_TEAM_ID = "T_FIXTURE_TEAM";

let mockChannel: {
  id: string;
  orgId: string;
  secrets: { signingSecret: string; botToken: string };
  config: { channelId: string; allowedUserIds: string[]; expectedTeamId?: string };
} | null = null;

let resolveApprovalCalls: Array<{ id: string; status: string; actor: string; orgId: string; opts: Record<string, unknown> }> = [];

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

mock.module("@/lib/feature-flags", () => ({
  isSlackApprovalStrict: () => false,
}));

mock.module("@/lib/slack/channel-validation", () => ({
  isSlackUserFromExpectedTeam: () => ({ allowed: true, reason: "same_team" }),
}));

mock.module("@/lib/data", () => ({
  getNotificationChannelByWebhookRef: async (_provider: string, ref: string) => {
    if (ref === FIXTURE_REF && mockChannel) return mockChannel;
    return null;
  },
  getApprovalByTelegramRef: async () => null,
  getEmployee: async () => null,
  resolveApproval: async (id: string, status: string, actor: string, orgId: string, opts: Record<string, unknown> = {}) => {
    resolveApprovalCalls.push({ id, status, actor, orgId, opts });
    return null;
  },
  getNotificationDelivery: async () => null,
}));

mock.module("@/lib/approvals/fulfill", () => ({
  fulfillIfApproved: async () => {},
}));

mock.module("@/lib/approvals/resolve-side-effects", () => ({
  runApprovalResolveSideEffects: async () => {},
}));

mock.module("@/lib/employees/approval-inbox", () => ({
  extraApproversAllow: () => true,
}));

mock.module("@/lib/admin-mcp/self-approval", () => ({
  isSelfApprovalDenied: () => false,
}));

mock.module("@/lib/approval-workflow", () => ({
  getMemberIdFromVoterBinding: async () => null,
}));

const { POST } = await import("./[ref]/route");

function makeSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
}

function makeRequest(ref: string, options: {
  payload: Record<string, unknown>;
  timestamp?: string;
  signature?: string;
  signingSecret?: string;
}): [Request, { params: Promise<{ ref: string }> }] {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const body = `payload=${encodeURIComponent(JSON.stringify(options.payload))}`;
  const signature = options.signature ?? makeSignature(
    options.signingSecret ?? FIXTURE_SIGNING_SECRET,
    timestamp,
    body
  );

  const req = new Request(`http://localhost/api/webhooks/slack/${ref}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });

  return [req, { params: Promise.resolve({ ref }) }];
}

describe("Slack [ref] webhook endpoint security", () => {
  beforeEach(() => {
    mockChannel = {
      id: FIXTURE_CHANNEL_ID,
      orgId: FIXTURE_ORG_ID,
      secrets: { signingSecret: FIXTURE_SIGNING_SECRET, botToken: "xoxb-test" },
      config: { channelId: "C_TEST", allowedUserIds: [FIXTURE_USER_ID] },
    };
    resolveApprovalCalls = [];
  });

  afterEach(() => {
    mockChannel = null;
  });

  test("unknown ref returns ack with ignored", async () => {
    const [req, ctx] = makeRequest("unknown_ref", {
      payload: {
        type: "block_actions",
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
  });

  test("bad signature is rejected with 401", async () => {
    const [req, ctx] = makeRequest(FIXTURE_REF, {
      payload: {
        type: "block_actions",
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
      signature: "v0=invalid_signature_here",
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
  });

  test("stale timestamp (>5min) is rejected with 401", async () => {
    const staleTimestamp = Math.floor((Date.now() - 6 * 60 * 1000) / 1000).toString();
    const payload = {
      type: "block_actions",
      user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
      actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const signature = makeSignature(FIXTURE_SIGNING_SECRET, staleTimestamp, body);

    const req = new Request(`http://localhost/api/webhooks/slack/${FIXTURE_REF}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": staleTimestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    const ctx = { params: Promise.resolve({ ref: FIXTURE_REF }) };

    const response = await POST(req, ctx);
    expect(response.status).toBe(401);
    const responseBody = await response.json();
    expect(responseBody.error).toBe("unauthorized");
  });

  test("valid request with correct signature is accepted", async () => {
    const [req, ctx] = makeRequest(FIXTURE_REF, {
      payload: {
        type: "block_actions",
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        channel: { id: "C_TEST" },
        message: { ts: "1234567890.123456" },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
        response_url: "https://hooks.slack.com/actions/T/B/xxx",
      },
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("url_verification challenge is returned", async () => {
    const [req, ctx] = makeRequest(FIXTURE_REF, {
      payload: {
        type: "url_verification",
        challenge: "test_challenge_token",
      },
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.challenge).toBe("test_challenge_token");
  });

  test("non-block_actions type returns ack", async () => {
    const [req, ctx] = makeRequest(FIXTURE_REF, {
      payload: {
        type: "view_submission",
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
      },
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("missing signing secret in channel config fails signature check", async () => {
    mockChannel = {
      id: FIXTURE_CHANNEL_ID,
      orgId: FIXTURE_ORG_ID,
      secrets: { signingSecret: "", botToken: "xoxb-test" },
      config: { channelId: "C_TEST", allowedUserIds: [FIXTURE_USER_ID] },
    };

    const [req, ctx] = makeRequest(FIXTURE_REF, {
      payload: {
        type: "block_actions",
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req, ctx);
    expect(response.status).toBe(401);
  });
});
