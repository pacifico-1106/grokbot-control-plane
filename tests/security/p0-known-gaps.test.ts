/**
 * P0 Known Gaps Tests
 * Tests for delivery unique constraint gap fix (approval_id, channel_id)
 *
 * When APPROVAL_RECIPIENT_ROUTING is ON, both DM delivery and channel delivery
 * can share the same channel_id. This test verifies that:
 * 1. Channel deliveries (recipient null) and per-recipient deliveries can coexist
 * 2. Legacy behavior (recipient null) still works when flag is OFF
 * 3. Upserts correctly target the right partial index
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval, resolveApproval } from "@/lib/data/approvals";
import {
  upsertNotificationChannel,
  recordNotificationDelivery,
  getNotificationDelivery,
  resetDemoNotificationChannels,
} from "@/lib/data/notification-channels";
import type { ApprovalRequest } from "@/lib/types";

describe("P0 delivery unique constraint gap fix", () => {
  let testChannel: { id: string; orgId: string };
  let testApproval: ApprovalRequest;
  const originalEnv = process.env.APPROVAL_RECIPIENT_ROUTING;

  beforeEach(async () => {
    resetDemoNotificationChannels(DEMO_ORG.id);
    delete process.env.APPROVAL_RECIPIENT_ROUTING;

    testChannel = await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "slack",
      label: "Test Channel",
      enabled: true,
      config: { channelId: "C_TEST" },
      secrets: { botToken: "xoxb-test", signingSecret: "test-secret" },
    });

    const result = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "Delivery constraint test",
      purpose: "test.delivery",
      summary: "Testing delivery unique constraint",
      risk: "low",
    });
    testApproval = result.approval;
  });

  afterEach(() => {
    resetDemoNotificationChannels(DEMO_ORG.id);
    if (originalEnv !== undefined) {
      process.env.APPROVAL_RECIPIENT_ROUTING = originalEnv;
    } else {
      delete process.env.APPROVAL_RECIPIENT_ROUTING;
    }
  });

  test("DM delivery and channel delivery can coexist for same (approval_id, channel_id)", async () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "true";

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "channel_msg_123",
      context: { channel: "C_TEST" },
      recipient: null,
      recipientKind: "channel",
    });

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "dm_msg_456",
      context: { dmUserId: "U_VOTER1" },
      recipient: "U_VOTER1",
      recipientKind: "dm",
    });

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "dm_msg_789",
      context: { dmUserId: "U_VOTER2" },
      recipient: "U_VOTER2",
      recipientKind: "dm",
    });

    const channelDelivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
      recipient: null,
    });
    expect(channelDelivery).not.toBeNull();
    expect(channelDelivery?.externalMessageId).toBe("channel_msg_123");

    const dm1Delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
      recipient: "U_VOTER1",
    });
    expect(dm1Delivery).not.toBeNull();
    expect(dm1Delivery?.externalMessageId).toBe("dm_msg_456");

    const dm2Delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
      recipient: "U_VOTER2",
    });
    expect(dm2Delivery).not.toBeNull();
    expect(dm2Delivery?.externalMessageId).toBe("dm_msg_789");
  });

  test("channel delivery upsert correctly updates existing row (recipient null)", async () => {
    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "msg_v1",
      context: { version: 1 },
    });

    let delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });
    expect(delivery?.externalMessageId).toBe("msg_v1");
    expect(delivery?.context.version).toBe(1);

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "msg_v2",
      context: { version: 2 },
    });

    delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });
    expect(delivery?.externalMessageId).toBe("msg_v2");
    expect(delivery?.context.version).toBe(2);
  });

  test("per-recipient upsert correctly updates existing row", async () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "true";

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "dm_v1",
      context: { version: 1 },
      recipient: "U_VOTER1",
      recipientKind: "dm",
    });

    let delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
      recipient: "U_VOTER1",
    });
    expect(delivery?.externalMessageId).toBe("dm_v1");

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "dm_v2",
      context: { version: 2 },
      recipient: "U_VOTER1",
      recipientKind: "dm",
    });

    delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
      recipient: "U_VOTER1",
    });
    expect(delivery?.externalMessageId).toBe("dm_v2");
    expect(delivery?.context.version).toBe(2);
  });
});

describe("P0 delivery constraint - flags OFF regression", () => {
  let testChannel: { id: string; orgId: string };
  let testApproval: ApprovalRequest;

  beforeEach(async () => {
    resetDemoNotificationChannels(DEMO_ORG.id);
    delete process.env.APPROVAL_RECIPIENT_ROUTING;

    testChannel = await upsertNotificationChannel({
      orgId: DEMO_ORG.id,
      provider: "slack",
      label: "Regression Channel",
      enabled: true,
      config: { channelId: "C_REGRESS" },
      secrets: { botToken: "xoxb-regress", signingSecret: "regress-secret" },
    });

    const result = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "Regression test",
      purpose: "test.regression",
      summary: "Testing legacy behavior with flag OFF",
      risk: "low",
    });
    testApproval = result.approval;
  });

  afterEach(() => {
    resetDemoNotificationChannels(DEMO_ORG.id);
    delete process.env.APPROVAL_RECIPIENT_ROUTING;
  });

  test("legacy channel delivery works without recipient parameter", async () => {
    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "legacy_123",
      context: { legacy: true },
    });

    const delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });

    expect(delivery).not.toBeNull();
    expect(delivery?.externalMessageId).toBe("legacy_123");
    expect(delivery?.context.legacy).toBe(true);
  });

  test("getNotificationDelivery without recipient returns channel delivery", async () => {
    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "channel_only",
      context: {},
      recipient: null,
      recipientKind: "channel",
    });

    const delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });

    expect(delivery).not.toBeNull();
    expect(delivery?.externalMessageId).toBe("channel_only");
  });

  test("multiple approvals can have channel deliveries to same channel", async () => {
    const result2 = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "Second approval",
      purpose: "test.second",
      summary: "Second approval for same channel",
      risk: "low",
    });
    const approval2 = result2.approval;

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "approval1_msg",
      context: {},
    });

    await recordNotificationDelivery({
      approval: approval2,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "approval2_msg",
      context: {},
    });

    const delivery1 = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });
    const delivery2 = await getNotificationDelivery({
      approvalId: approval2.id,
      channelId: testChannel.id,
    });

    expect(delivery1?.externalMessageId).toBe("approval1_msg");
    expect(delivery2?.externalMessageId).toBe("approval2_msg");
  });

  test("upsert updates existing delivery correctly with flag OFF", async () => {
    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "original",
      context: { count: 1 },
    });

    await recordNotificationDelivery({
      approval: testApproval,
      channelId: testChannel.id,
      provider: "slack",
      externalMessageId: "updated",
      context: { count: 2 },
    });

    const delivery = await getNotificationDelivery({
      approvalId: testApproval.id,
      channelId: testChannel.id,
    });

    expect(delivery?.externalMessageId).toBe("updated");
    expect(delivery?.context.count).toBe(2);
  });
});
