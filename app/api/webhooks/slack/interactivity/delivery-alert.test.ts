/**
 * PR-3: signature-verified Slack button failures raise the fail-closed alert;
 * the approval is never granted on those paths. Successful presses do not alert.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "@/tests/helpers/scoped-module-mock";
import { createHmac } from "node:crypto";

const SECRET = "test_signing_secret_alert";
const APP = "A_ALERT_APP";
const TEAM = "T_ALERT_TEAM";
const USER = "U_APPROVER";

let alertOn = true;
const alerts: Array<Record<string, unknown>> = [];
let approval: Record<string, unknown> | null = null;
let delivery: Record<string, unknown> | null = null;
const resolveCalls: unknown[] = [];

// File-scoped mocks (tests/helpers/scoped-module-mock.ts): bun's mock.module is
// process-global; plain partial mocks here replaced "@/lib/data",
// notification-channels and the alert module for every later file in the same
// bun process. Overrides below are unchanged; they only apply while this file runs.
const scope = scopedModuleMocks();
await scope.mock("@/lib/notify/delivery-failure-alert", {
  isApprovalDeliveryFailureAlertEnabled: () => alertOn,
  alertApprovalDeliveryFailure: async (input: Record<string, unknown>) => {
    alerts.push(input);
    return { status: "sent" };
  },
});
await scope.mock("@/lib/slack/interactivity-channel-resolver", {
  findChannelCandidatesByAppAndTeam: async (apiAppId: string, teamId: string) =>
    apiAppId === APP
      ? [{ id: "chn_a", orgId: "org_a", signingSecret: SECRET, apiAppId: APP, teamId, expectedTeamId: TEAM, allowedUserIds: [USER] }]
      : [],
});
await scope.mock("@/lib/data", {
  getApprovalByTelegramRef: async () => approval,
  getApprovalById: async () => approval,
  getEmployee: async () => ({ id: "emp_1", approverUserIds: [] }),
  resolveApproval: async (...args: unknown[]) => {
    resolveCalls.push(args);
    return null;
  },
});
await scope.mock("@/lib/data/notification-channels", {
  getApprovalIdByDeliveryExternal: async () => null,
  getNotificationDelivery: async () => delivery,
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
});
await scope.mock("@/lib/approvals/fulfill", { fulfillIfApproved: async () => {} });
await scope.mock("@/lib/approvals/resolve-side-effects", { runApprovalResolveSideEffects: async () => {} });
await scope.mock("@/lib/employees/approval-inbox", { extraApproversAllow: () => true });
await scope.mock("@/lib/admin-mcp/self-approval", { isSelfApprovalDenied: () => false });
await scope.mock("@/lib/approval-workflow", { getMemberIdFromVoterBinding: async () => null });
await scope.mock("@/lib/slack/ephemeral-rejection", { sendEphemeralRejection: async () => {} });

const { POST } = await import("./route");

function req(payload: Record<string, unknown>, secret = SECRET): Request {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("http://localhost/api/webhooks/slack/interactivity", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

function press(user = USER, extra: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    api_app_id: APP,
    team: { id: TEAM },
    user: { id: user, team_id: TEAM },
    channel: { id: "D_APPROVER" },
    message: { ts: "111.222" },
    response_url: "",
    actions: [{ action_id: "staffpass_approve", value: "ref_1" }],
    ...extra,
  };
}

beforeEach(() => {
  alertOn = true;
  alerts.length = 0;
  resolveCalls.length = 0;
  approval = { id: "apr_1", orgId: "org_a", employeeId: "emp_1", status: "pending", createdAt: new Date().toISOString() };
  delivery = { externalMessageId: "111.222", context: { channel: "D_APPROVER" } };
});

describe("Slack button failure → fail-closed alert", () => {
  test("happy path: vote recorded, no alert", async () => {
    const res = await POST(req(press()));
    expect(res.status).toBe(200);
    expect(resolveCalls).toHaveLength(1);
    expect(alerts).toHaveLength(0);
  });

  test("presser not in allowed list → alert, not approved", async () => {
    await POST(req(press("U_STRANGER")));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orgId: "org_a", kind: "button_failed", reason: "not_in_allowed_list", channelId: "chn_a" });
  });

  test("external-team presser → alert, not approved", async () => {
    await POST(req(press(USER, { user: { id: USER, team_id: "T_OTHER" } })));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts[0]).toMatchObject({ reason: "external_team_user" });
  });

  test("delivery mismatch → alert with approvalId, not approved", async () => {
    delivery = { externalMessageId: "999.999", context: { channel: "D_APPROVER" } };
    await POST(req(press()));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts[0]).toMatchObject({ reason: "delivery_mismatch", approvalId: "apr_1" });
  });

  test("time-expired card → alert, not approved", async () => {
    approval = { ...approval!, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    await POST(req(press()));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts[0]).toMatchObject({ reason: "card_expired", approvalId: "apr_1" });
  });

  test("already-decided approval (normal double press) → no alert", async () => {
    approval = { ...approval!, status: "approved" };
    await POST(req(press()));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  test("bad signature (unverified) → 401 and NO alert (no unauthenticated alert spam)", async () => {
    const res = await POST(req(press(), "wrong_secret"));
    expect(res.status).toBe(401);
    expect(alerts).toHaveLength(0);
  });

  test("flag OFF → identical behavior, no alert", async () => {
    alertOn = false;
    await POST(req(press("U_STRANGER")));
    expect(resolveCalls).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });
});
