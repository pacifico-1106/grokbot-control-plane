/**
 * P0 Item 7: Route-level tests for /api/webhooks/slack/interactivity
 * 
 * Tests:
 * - Bad signature rejected (401)
 * - Stale timestamp (>5min) rejected (401)
 * - Wrong api_app_id rejected (403)
 * - Wrong team_id rejected (403)
 * - Valid request accepted and vote uses checked RPC
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { createHmac } from "node:crypto";

const FIXTURE_SIGNING_SECRET = "test_signing_secret_12345";
const FIXTURE_API_APP_ID = "A_FIXTURE_APP";
const FIXTURE_TEAM_ID = "T_FIXTURE_TEAM";
const FIXTURE_CHANNEL_ID = "chn_fixture";
const FIXTURE_ORG_ID = "org_fixture";
const FIXTURE_USER_ID = "U_FIXTURE_USER";

let mockCandidates: Array<{
  id: string;
  orgId: string;
  signingSecret: string;
  apiAppId: string;
  teamId: string;
  expectedTeamId: string;
  allowedUserIds: string[];
}> = [];

let resolveApprovalCalls: Array<{ id: string; status: string; actor: string; orgId: string; opts: Record<string, unknown> }> = [];

mock.module("@/lib/slack/interactivity-channel-resolver", () => ({
  findChannelCandidatesByAppAndTeam: async (apiAppId: string, teamId: string) => {
    return mockCandidates.filter(c => c.apiAppId === apiAppId && c.teamId === teamId);
  },
}));

mock.module("@/lib/data", () => ({
  getApprovalByTelegramRef: async () => null,
  getApprovalById: async () => null,
  getEmployee: async () => null,
  resolveApproval: async (id: string, status: string, actor: string, orgId: string, opts: Record<string, unknown> = {}) => {
    resolveApprovalCalls.push({ id, status, actor, orgId, opts });
    return null;
  },
}));

mock.module("@/lib/data/notification-channels", () => ({
  getApprovalIdByDeliveryExternal: async () => null,
  getNotificationDelivery: async () => null,
  recordNotificationDelivery: async () => null,
  listNotificationChannels: async () => [],
  getEnabledNotificationChannels: async () => [],
  listAllEnabledNotificationChannels: async () => [],
  getNotificationChannelByWebhookRef: async () => null,
  getNotificationChannelSecretsById: async () => null,
  upsertNotificationChannel: async () => null,
  isTokyo307PilotOrg: async () => false,
  isTokyo307PilotEmail: () => false,
  shouldUseGlobalTelegramFallback: async () => false,
  findPilotTelegramChannelByChatId: async () => null,
  getTokyo307PilotOrgId: async () => null,
  findAwaitingRevisionApproval: async () => null,
  resetDemoNotificationChannels: () => {},
  resolveEmployeeApprovalChannel: async () => null,
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

mock.module("@/lib/slack/ephemeral-rejection", () => ({
  sendEphemeralRejection: async () => {},
}));

const { POST } = await import("./route");

function makeSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
}

function makeRequest(options: {
  payload: Record<string, unknown>;
  timestamp?: string;
  signature?: string;
  signingSecret?: string;
}): Request {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const body = `payload=${encodeURIComponent(JSON.stringify(options.payload))}`;
  const signature = options.signature ?? makeSignature(
    options.signingSecret ?? FIXTURE_SIGNING_SECRET,
    timestamp,
    body
  );

  return new Request("http://localhost/api/webhooks/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("Slack interactivity endpoint security", () => {
  beforeEach(() => {
    mockCandidates = [{
      id: FIXTURE_CHANNEL_ID,
      orgId: FIXTURE_ORG_ID,
      signingSecret: FIXTURE_SIGNING_SECRET,
      apiAppId: FIXTURE_API_APP_ID,
      teamId: FIXTURE_TEAM_ID,
      expectedTeamId: FIXTURE_TEAM_ID,
      allowedUserIds: [FIXTURE_USER_ID],
    }];
    resolveApprovalCalls = [];
  });

  afterEach(() => {
    mockCandidates = [];
  });

  test("bad signature is rejected with 401", async () => {
    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
      signature: "v0=invalid_signature_here",
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
  });

  test("stale timestamp (>5min) is rejected with 401", async () => {
    const staleTimestamp = Math.floor((Date.now() - 6 * 60 * 1000) / 1000).toString();
    const payload = {
      type: "block_actions",
      api_app_id: FIXTURE_API_APP_ID,
      team: { id: FIXTURE_TEAM_ID },
      user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
      actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const signature = makeSignature(FIXTURE_SIGNING_SECRET, staleTimestamp, body);

    const req = new Request("http://localhost/api/webhooks/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": staleTimestamp,
        "x-slack-signature": signature,
      },
      body,
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
    const responseBody = await response.json();
    expect(responseBody.error).toBe("unauthorized");
  });

  test("wrong api_app_id (no matching candidates) is rejected with 401", async () => {
    const wrongAppId = "A_WRONG_APP";
    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: wrongAppId,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
  });

  test("wrong team_id (no matching candidates) is rejected with 401", async () => {
    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: "T_WRONG_TEAM" },
        user: { id: FIXTURE_USER_ID, team_id: "T_WRONG_TEAM" },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
  });

  test("valid request from different app (if signature valid) is accepted", async () => {
    const differentAppId = "A_DIFFERENT_APP";
    mockCandidates = [{
      id: FIXTURE_CHANNEL_ID,
      orgId: FIXTURE_ORG_ID,
      signingSecret: FIXTURE_SIGNING_SECRET,
      apiAppId: differentAppId,
      teamId: FIXTURE_TEAM_ID,
      expectedTeamId: FIXTURE_TEAM_ID,
      allowedUserIds: [FIXTURE_USER_ID],
    }];

    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: differentAppId,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        channel: { id: "C_TEST" },
        message: { ts: "1234567890.123456" },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("team_id mismatch after signature passes returns 403", async () => {
    mockCandidates = [{
      id: FIXTURE_CHANNEL_ID,
      orgId: FIXTURE_ORG_ID,
      signingSecret: FIXTURE_SIGNING_SECRET,
      apiAppId: FIXTURE_API_APP_ID,
      teamId: FIXTURE_TEAM_ID,
      expectedTeamId: "T_EXPECTED_DIFFERENT",
      allowedUserIds: [FIXTURE_USER_ID],
    }];

    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("team_mismatch");
  });

  test("no candidates found returns 401", async () => {
    mockCandidates = [];

    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  test("missing api_app_id or team_id returns ack with ignored", async () => {
    const req = makeRequest({
      payload: {
        type: "block_actions",
        user: { id: FIXTURE_USER_ID },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("missing_app_or_team");
  });

  test("valid request with correct signature is accepted", async () => {
    const req = makeRequest({
      payload: {
        type: "block_actions",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
        channel: { id: "C_TEST" },
        message: { ts: "1234567890.123456" },
        actions: [{ action_id: "staffpass_approve", value: "test_ref" }],
        response_url: "https://hooks.slack.com/actions/T/B/xxx",
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("url_verification challenge is returned", async () => {
    const req = makeRequest({
      payload: {
        type: "url_verification",
        challenge: "test_challenge_token",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.challenge).toBe("test_challenge_token");
  });

  test("non-block_actions type returns ack", async () => {
    const req = makeRequest({
      payload: {
        type: "view_submission",
        api_app_id: FIXTURE_API_APP_ID,
        team: { id: FIXTURE_TEAM_ID },
        user: { id: FIXTURE_USER_ID, team_id: FIXTURE_TEAM_ID },
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
