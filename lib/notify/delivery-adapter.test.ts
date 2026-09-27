/**
 * Tests for ApprovalDeliveryAdapter layer.
 * P0 Item 4: Verify security invariants for channel-agnostic delivery.
 *
 * Key invariants:
 * - No shared channel delivery (Slack Connect blocked)
 * - No cross-org delivery
 * - Admin-class never routes to business voters
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { ApprovalRequest, Employee } from "@/lib/types";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  } as Response)
);
global.fetch = mockFetch as unknown as typeof fetch;

mock.module("@/lib/data/notification-channels", () => ({
  getEnabledNotificationChannels: mock(() => Promise.resolve([])),
  getNotificationChannelSecretsById: mock(() => Promise.resolve(null)),
  resolveEmployeeApprovalChannel: mock(() => Promise.resolve(null)),
}));

mock.module("@/lib/approval-workflow/voter-binding", () => ({
  listVoterBindings: mock(() => Promise.resolve([])),
}));

mock.module("@/lib/notify/slack", () => ({
  sendApprovalToSlackChannel: mock(() => Promise.resolve({ ok: true })),
  editSlackApprovalForChannel: mock(() => Promise.resolve({ ok: true })),
  editSlackWorkflowProgress: mock(() => Promise.resolve({ ok: true })),
}));

import {
  isRecipientRoutingEnabled,
  routeApprovalToRecipients,
  checkSharedChannelDeliveryAllowed,
  validateDeliveryRecipient,
} from "./recipient-routing";
import {
  createDeliveryAdapter,
  hasDeliveryAdapter,
  type DeliveryRecipient,
} from "./delivery-adapter";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import * as notificationChannels from "@/lib/data/notification-channels";
import * as voterBinding from "@/lib/approval-workflow/voter-binding";

const createMockApproval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "approval-1",
  orgId: "org-1",
  title: "Test Request",
  summary: "Test summary",
  risk: "medium",
  status: "pending",
  purpose: "test",
  employeeId: "emp-1",
  channelId: "channel-1",
  externalMessageId: null,
  context: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: "emp-1",
  orgId: "org-1",
  name: "Test Employee",
  slackId: "U12345",
  email: "test@example.com",
  jobTitle: "Engineer",
  onLeave: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockChannel = (overrides: Partial<NotificationChannelRuntime> = {}): NotificationChannelRuntime => ({
  id: "channel-1",
  orgId: "org-1",
  provider: "slack",
  name: "Test Channel",
  enabled: true,
  isDefault: true,
  config: { channelId: "C12345" },
  secrets: { botToken: "xoxb-test-token", signingSecret: "test-secret" },
  ...overrides,
} as NotificationChannelRuntime);

describe("isRecipientRoutingEnabled", () => {
  const originalEnv = process.env.APPROVAL_RECIPIENT_ROUTING;

  beforeEach(() => {
    delete process.env.APPROVAL_RECIPIENT_ROUTING;
  });

  test("returns false when flag is not set (default OFF)", () => {
    expect(isRecipientRoutingEnabled()).toBe(false);
  });

  test("returns true when flag is 'true'", () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "true";
    expect(isRecipientRoutingEnabled()).toBe(true);
  });

  test("returns true when flag is '1'", () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "1";
    expect(isRecipientRoutingEnabled()).toBe(true);
  });

  test("returns true when flag is 'on'", () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "on";
    expect(isRecipientRoutingEnabled()).toBe(true);
  });

  test("returns true when flag is 'enabled'", () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "enabled";
    expect(isRecipientRoutingEnabled()).toBe(true);
  });

  test("returns false for invalid values", () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "yes";
    expect(isRecipientRoutingEnabled()).toBe(false);
  });
});

describe("routeApprovalToRecipients", () => {
  const originalEnv = process.env.APPROVAL_RECIPIENT_ROUTING;

  beforeEach(() => {
    delete process.env.APPROVAL_RECIPIENT_ROUTING;
    mockFetch.mockClear();
  });

  test("falls back to default when feature flag is OFF", async () => {
    const approval = createMockApproval();
    const employee = createMockEmployee();

    const result = await routeApprovalToRecipients({
      approval,
      employee,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("feature_flag_off");
  });

  test("admin-class approval always falls back to default channel", async () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "true";

    const adminApproval = createMockApproval({
      context: { class: "admin" },
      purpose: "staffpass_admin_workflow",
    });
    const employee = createMockEmployee();

    const result = await routeApprovalToRecipients({
      approval: adminApproval,
      employee,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("admin_class_uses_default_channel");
  });

  test("falls back to default when no default channel found", async () => {
    process.env.APPROVAL_RECIPIENT_ROUTING = "true";

    const approval = createMockApproval();
    const employee = createMockEmployee();

    spyOn(notificationChannels, "resolveEmployeeApprovalChannel").mockResolvedValue(null);

    const result = await routeApprovalToRecipients({
      approval,
      employee,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("no_default_channel");
  });
});

describe("validateDeliveryRecipient", () => {
  test("admin-class must use channel delivery", () => {
    const adminApproval = createMockApproval({
      context: { class: "admin" },
      purpose: "staffpass_admin_workflow",
    });

    const dmRecipient: DeliveryRecipient = {
      kind: "dm",
      provider: "slack",
      channelId: "channel-1",
      externalUserId: "U12345",
    };

    const result = validateDeliveryRecipient(dmRecipient, adminApproval);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("admin_class_must_use_channel");
  });

  test("admin-class can use channel delivery", () => {
    const adminApproval = createMockApproval({
      context: { class: "admin" },
      purpose: "staffpass_admin_workflow",
    });

    const channelRecipient: DeliveryRecipient = {
      kind: "channel",
      provider: "slack",
      channelId: "channel-1",
    };

    const result = validateDeliveryRecipient(channelRecipient, adminApproval);
    expect(result.valid).toBe(true);
  });

  test("business-class can use DM delivery", () => {
    const businessApproval = createMockApproval();

    const dmRecipient: DeliveryRecipient = {
      kind: "dm",
      provider: "slack",
      channelId: "channel-1",
      externalUserId: "U12345",
    };

    const result = validateDeliveryRecipient(dmRecipient, businessApproval);
    expect(result.valid).toBe(true);
  });

  test("business-class can use thread delivery", () => {
    const businessApproval = createMockApproval();

    const threadRecipient: DeliveryRecipient = {
      kind: "thread",
      provider: "slack",
      channelId: "channel-1",
      threadTs: "1234567890.123456",
    };

    const result = validateDeliveryRecipient(threadRecipient, businessApproval);
    expect(result.valid).toBe(true);
  });
});

describe("checkSharedChannelDeliveryAllowed", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  test("returns not allowed when no adapter available", async () => {
    const result = await checkSharedChannelDeliveryAllowed(
      "unknown_provider" as any,
      "channel-1",
      "org-1"
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_adapter");
  });
});

describe("hasDeliveryAdapter", () => {
  test("returns true for registered providers", () => {
    expect(hasDeliveryAdapter("slack")).toBe(true);
    expect(hasDeliveryAdapter("telegram")).toBe(true);
    expect(hasDeliveryAdapter("line")).toBe(true);
  });

  test("returns false for unknown providers", () => {
    expect(hasDeliveryAdapter("unknown" as any)).toBe(false);
  });
});

describe("SlackDeliveryAdapter - shared channel blocking", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  test("isSharedChannel returns shared=true for Slack Connect channel", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            channel: {
              id: "C12345",
              is_ext_shared: true,
              is_shared: false,
            },
          }),
      } as Response)
    );

    const mockChannel = createMockChannel();
    spyOn(notificationChannels, "getEnabledNotificationChannels").mockResolvedValue([mockChannel]);

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(true);
    expect(result.reason).toBe("slack_connect_channel");
  });

  test("isSharedChannel returns shared=true for externally shared channel", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            channel: {
              id: "C12345",
              is_ext_shared: false,
              is_shared: true,
            },
          }),
      } as Response)
    );

    const mockChannel = createMockChannel();
    spyOn(notificationChannels, "getEnabledNotificationChannels").mockResolvedValue([mockChannel]);

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(true);
    expect(result.reason).toBe("externally_shared_channel");
  });

  test("isSharedChannel returns shared=false for private channel", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            channel: {
              id: "C12345",
              is_ext_shared: false,
              is_shared: false,
              is_pending_ext_shared: false,
            },
          }),
      } as Response)
    );

    const mockChannel = createMockChannel();
    spyOn(notificationChannels, "getEnabledNotificationChannels").mockResolvedValue([mockChannel]);

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(false);
  });
});

describe("Cross-org delivery isolation", () => {
  test("adapter only loads channels for its own org", async () => {
    const mockChannel = createMockChannel({ orgId: "org-1" });
    const getChannelsSpy = spyOn(notificationChannels, "getEnabledNotificationChannels").mockResolvedValue([mockChannel]);

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");

    expect(getChannelsSpy).toHaveBeenCalledWith("org-1");
    expect(adapter).not.toBeNull();
  });

  test("adapter cannot access channels from different org", async () => {
    const mockChannel = createMockChannel({ orgId: "org-1", id: "channel-1" });
    spyOn(notificationChannels, "getEnabledNotificationChannels").mockResolvedValue([mockChannel]);

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-2");
    expect(adapter).not.toBeNull();

    const result = await adapter!.sendCard({
      approval: createMockApproval({ orgId: "org-2" }),
      employee: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
    expect(result.skipped).toBe(true);
  });
});

describe("Stub adapters", () => {
  test("TelegramDeliveryAdapter returns not implemented", async () => {
    const adapter = await createDeliveryAdapter("telegram", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.sendCard({
      approval: createMockApproval(),
      employee: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("telegram_adapter_not_implemented");
    expect(result.skipped).toBe(true);
  });

  test("LineDeliveryAdapter returns not implemented", async () => {
    const adapter = await createDeliveryAdapter("line", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.sendCard({
      approval: createMockApproval(),
      employee: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("line_adapter_not_implemented");
    expect(result.skipped).toBe(true);
  });
});
