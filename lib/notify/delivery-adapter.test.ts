/**
 * Tests for ApprovalDeliveryAdapter layer.
 * P0 Item 4: Verify security invariants for channel-agnostic delivery.
 *
 * Key invariants:
 * - No shared channel delivery (Slack Connect blocked)
 * - No cross-org delivery
 * - Admin-class never routes to business voters
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ApprovalRequest, Employee, NotificationProvider } from "@/lib/types";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

let mockChannels: NotificationChannelRuntime[] = [];

mock.module("@/lib/data/notification-channels", () => ({
  getEnabledNotificationChannels: async (orgId: string) =>
    mockChannels.filter((c) => c.orgId === orgId),
  getNotificationChannelSecretsById: async () => null,
  resolveEmployeeApprovalChannel: async (orgId: string) =>
    mockChannels.find((c) => c.orgId === orgId && c.isDefault) ?? null,
}));

mock.module("@/lib/approval-workflow/voter-binding", () => ({
  listVoterBindings: async () => [],
}));

mock.module("@/lib/notify/slack", () => ({
  sendApprovalToSlackChannel: async () => ({ ok: true }),
  editSlackApprovalForChannel: async () => ({ ok: true }),
  editSlackWorkflowProgress: async () => ({ ok: true }),
}));

let mockFetchResponse: {
  ok: boolean;
  channel?: { id?: string; is_ext_shared?: boolean; is_shared?: boolean; is_pending_ext_shared?: boolean };
  error?: string;
} = { ok: true, channel: { id: "C12345" } };

const originalFetch = global.fetch;
global.fetch = async () =>
  ({
    ok: true,
    json: async () => mockFetchResponse,
  }) as Response;

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

const createMockApproval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "approval-1",
  orgId: "org-1",
  employeeId: "emp-1",
  credentialId: "cred-1",
  title: "Test Request",
  summary: "Test summary",
  risk: "medium",
  status: "pending",
  purpose: "test",
  revisionNote: null,
  revisionCount: 0,
  parentApprovalId: null,
  telegramRef: null,
  telegramMessageId: null,
  metadata: {},
  statusToken: "token-1",
  pollPath: "/api/approvals/status",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  ...overrides,
});

const createMockEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: "emp-1",
  orgId: "org-1",
  displayName: "Test Employee",
  roleLabel: "Engineer",
  jobDescription: "Test job",
  status: "active",
  scopes: [],
  allowedPurposes: [],
  approvalPolicy: "always_human",
  sodLevel: "ok",
  actionLimits: {},
  voice: { template: "polite", register: "polite", endings: "desumasu", forbidden: [], signOff: null, externalFloor: "polite" },
  projectAccess: { mode: "company", projectIds: [] },
  credentialId: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const createMockChannel = (overrides: Partial<NotificationChannelRuntime> = {}): NotificationChannelRuntime =>
  ({
    id: "channel-1",
    orgId: "org-1",
    provider: "slack",
    name: "Test Channel",
    enabled: true,
    isDefault: true,
    config: { channelId: "C12345" },
    secrets: { botToken: "xoxb-test-token", signingSecret: "test-secret" },
    ...overrides,
  }) as NotificationChannelRuntime;

describe("isRecipientRoutingEnabled", () => {
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
  beforeEach(() => {
    delete process.env.APPROVAL_RECIPIENT_ROUTING;
    mockChannels = [];
    mockFetchResponse = { ok: true, channel: { id: "C12345" } };
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
      metadata: { approvalClass: "admin" },
      purpose: "admin.hire",
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
      metadata: { approvalClass: "admin" },
      purpose: "admin.hire",
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
      metadata: { approvalClass: "admin" },
      purpose: "admin.hire",
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
    mockChannels = [];
    mockFetchResponse = { ok: true, channel: { id: "C12345" } };
  });

  test("returns not allowed when no adapter available", async () => {
    const result = await checkSharedChannelDeliveryAllowed(
      "unknown_provider" as NotificationProvider,
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
    expect(hasDeliveryAdapter("unknown" as NotificationProvider)).toBe(false);
  });
});

describe("SlackDeliveryAdapter - shared channel blocking", () => {
  beforeEach(() => {
    mockChannels = [createMockChannel()];
    mockFetchResponse = { ok: true, channel: { id: "C12345" } };
  });

  test("isSharedChannel returns shared=true for Slack Connect channel", async () => {
    mockFetchResponse = {
      ok: true,
      channel: {
        id: "C12345",
        is_ext_shared: true,
        is_shared: false,
      },
    };

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(true);
    expect(result.reason).toBe("slack_connect_channel");
  });

  test("isSharedChannel returns shared=true for externally shared channel", async () => {
    mockFetchResponse = {
      ok: true,
      channel: {
        id: "C12345",
        is_ext_shared: false,
        is_shared: true,
      },
    };

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(true);
    expect(result.reason).toBe("externally_shared_channel");
  });

  test("isSharedChannel returns shared=false for private channel", async () => {
    mockFetchResponse = {
      ok: true,
      channel: {
        id: "C12345",
        is_ext_shared: false,
        is_shared: false,
        is_pending_ext_shared: false,
      },
    };

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.isSharedChannel();
    expect(result.shared).toBe(false);
  });

  test("sendCard blocks delivery to shared channel", async () => {
    mockFetchResponse = {
      ok: true,
      channel: {
        id: "C12345",
        is_ext_shared: true,
      },
    };

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    const result = await adapter!.sendCard({
      approval: createMockApproval(),
      employee: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("shared_channel_blocked");
    expect(result.skipped).toBe(true);
  });
});

describe("Cross-org delivery isolation", () => {
  beforeEach(() => {
    mockChannels = [createMockChannel({ orgId: "org-1", id: "channel-1" })];
    mockFetchResponse = { ok: true, channel: { id: "C12345" } };
  });

  test("adapter cannot access channels from different org", async () => {
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

  test("adapter loads only channels for its own org", async () => {
    mockChannels = [
      createMockChannel({ orgId: "org-1", id: "channel-1" }),
      createMockChannel({ orgId: "org-2", id: "channel-2" }),
    ];

    const adapter = await createDeliveryAdapter("slack", "channel-1", "org-1");
    expect(adapter).not.toBeNull();

    mockFetchResponse = { ok: true, channel: { id: "C12345", is_ext_shared: false, is_shared: false } };

    const result = await adapter!.sendCard({
      approval: createMockApproval({ orgId: "org-1" }),
      employee: null,
    });

    expect(result.ok).toBe(true);
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
