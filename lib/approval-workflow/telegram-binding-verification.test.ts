/**
 * Tests for Telegram global binding verification.
 * P0 Fix: telegram:global binding for org owners
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OrgMember } from "@/lib/types";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_MEMBER_ID = "00000000-0000-0000-0000-000000000002";
const NON_OWNER_MEMBER_ID = "00000000-0000-0000-0000-000000000003";
const TELEGRAM_USER_ID = "12345678";

const ownerMember: OrgMember = {
  id: OWNER_MEMBER_ID,
  orgId: DEMO_ORG_ID,
  email: "owner@example.com",
  displayName: "八坂",
  role: "owner",
  capabilities: ["approve_actions"],
  status: "active",
  jobRole: "owner",
};

const nonOwnerMember: OrgMember = {
  id: NON_OWNER_MEMBER_ID,
  orgId: DEMO_ORG_ID,
  email: "approver@example.com",
  displayName: "山下",
  role: "admin",
  capabilities: ["approve_actions"],
  status: "active",
  jobRole: "admin_affairs",
};

const demoMembers = new Map<string, OrgMember>();

mock.module("@/lib/demo-data", () => ({
  getRuntimeMemberById: (id: string) => demoMembers.get(id) ?? null,
  setRuntimeMember: (m: OrgMember) => demoMembers.set(m.id, m),
  resetRuntimeMembers: () => demoMembers.clear(),
}));

const {
  createPendingVoterBinding,
  verifyVoterBinding,
  getVoterBinding,
  resetDemoVoterBindings,
  isTelegramGlobalChannelKey,
  TELEGRAM_GLOBAL_CHANNEL_KEY,
} = await import("./voter-binding");

const { resetDemoWorkflowData } = await import("./data");

const {
  parseTelegramVerificationCallbackValue,
  handleTelegramVerificationConfirm,
  handleTelegramVerificationReject,
  buildTelegramVerificationCallbackValue,
} = await import("./telegram-binding-verification");

describe("telegram:global channel key", () => {
  test("isTelegramGlobalChannelKey identifies telegram:global", () => {
    expect(isTelegramGlobalChannelKey("telegram:global")).toBe(true);
    expect(isTelegramGlobalChannelKey("telegram:other")).toBe(false);
    expect(isTelegramGlobalChannelKey("slack:channel")).toBe(false);
    expect(isTelegramGlobalChannelKey("")).toBe(false);
  });

  test("TELEGRAM_GLOBAL_CHANNEL_KEY constant", () => {
    expect(TELEGRAM_GLOBAL_CHANNEL_KEY).toBe("telegram:global");
  });
});

describe("telegram:global voter binding creation", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(ownerMember.id, ownerMember);
    demoMembers.set(nonOwnerMember.id, nonOwnerMember);
  });

  test("createPendingVoterBinding accepts telegram:global for org member", async () => {
    const result = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.status).toBe("pending");
      expect(result.binding.channelKey).toBe(TELEGRAM_GLOBAL_CHANNEL_KEY);
      expect(result.binding.provider).toBe("telegram");
      expect(result.verificationCode).toMatch(/^\d{6}$/);
    }
  });

  test("verify telegram:global binding activates it", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      verificationCode: createResult.verificationCode,
    });

    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      expect(verifyResult.binding.status).toBe("active");
      expect(verifyResult.binding.verifiedAt).toBeDefined();
    }
  });
});

describe("telegram verification callback parsing", () => {
  test("parseTelegramVerificationCallbackValue rejects invalid format", () => {
    const result = parseTelegramVerificationCallbackValue("invalid");
    expect(result.ok).toBe(false);
  });

  test("parseTelegramVerificationCallbackValue rejects invalid signature", async () => {
    const { generateVerificationNonce } = await import("./voter-binding");
    const nonce = generateVerificationNonce();
    const result = parseTelegramVerificationCallbackValue(`${nonce}.fakehash.invalidsig`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("signature_invalid");
    }
  });
});

describe("telegram verification confirm handler", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(ownerMember.id, ownerMember);
  });

  test("handleTelegramVerificationConfirm rejects user mismatch", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const wrongUserResult = await handleTelegramVerificationConfirm({
      callbackValue: "invalid_callback_value",
      presserTelegramUserId: "wrong_user",
      expectedChannelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      expectedOrgId: DEMO_ORG_ID,
    });

    expect(wrongUserResult.ok).toBe(false);
    if (!wrongUserResult.ok) {
      expect(wrongUserResult.reason).toBe("invalid_format");
    }
  });
});

describe("telegram verification reject handler", () => {
  test("handleTelegramVerificationReject returns success for valid rejection", async () => {
    const result = await handleTelegramVerificationReject({
      callbackValue: "invalid",
      presserTelegramUserId: TELEGRAM_USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_format");
    }
  });
});

describe("getMemberIdFromVoterBinding with telegram:global", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    resetDemoWorkflowData();
    demoMembers.clear();
    demoMembers.set(ownerMember.id, ownerMember);
  });

  test("returns null for unverified telegram:global binding", async () => {
    const { getMemberIdFromVoterBinding } = await import("./data");

    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const memberId = await getMemberIdFromVoterBinding(DEMO_ORG_ID, {
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      userId: TELEGRAM_USER_ID,
    });

    expect(memberId).toBeNull();
  });

  test("returns member ID for verified telegram:global binding", async () => {
    const { getMemberIdFromVoterBinding } = await import("./data");

    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      verificationCode: createResult.verificationCode,
    });

    const memberId = await getMemberIdFromVoterBinding(DEMO_ORG_ID, {
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      userId: TELEGRAM_USER_ID,
    });

    expect(memberId).toBe(OWNER_MEMBER_ID);
  });
});

const TENANT_CHANNEL_ID = "98eb7dd7-f401-4291-a9de-64b510d90d31";

describe("telegram tenant channel verification", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    resetDemoWorkflowData();
    demoMembers.clear();
    demoMembers.set(ownerMember.id, ownerMember);
  });

  test("createPendingVoterBinding accepts tenant channel UUID as channelKey", async () => {
    const result = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.status).toBe("pending");
      expect(result.binding.channelKey).toBe(TENANT_CHANNEL_ID);
      expect(result.binding.provider).toBe("telegram");
    }
  });

  test("verify tenant channel binding activates it", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      verificationCode: createResult.verificationCode,
    });

    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      expect(verifyResult.binding.status).toBe("active");
      expect(verifyResult.binding.channelKey).toBe(TENANT_CHANNEL_ID);
    }
  });

  test("getMemberIdFromVoterBinding returns member ID for verified tenant channel binding", async () => {
    const { getMemberIdFromVoterBinding } = await import("./data");

    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      verificationCode: createResult.verificationCode,
    });

    const memberId = await getMemberIdFromVoterBinding(DEMO_ORG_ID, {
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      userId: TELEGRAM_USER_ID,
    });

    expect(memberId).toBe(OWNER_MEMBER_ID);
  });

  test("telegram:global binding does NOT match tenant channel lookup", async () => {
    const { getMemberIdFromVoterBinding } = await import("./data");

    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TELEGRAM_GLOBAL_CHANNEL_KEY,
      externalUserId: TELEGRAM_USER_ID,
      verificationCode: createResult.verificationCode,
    });

    const memberId = await getMemberIdFromVoterBinding(DEMO_ORG_ID, {
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      userId: TELEGRAM_USER_ID,
    });

    expect(memberId).toBeNull();
  });

  test("parseTelegramVerificationCallbackValue returns channelKey from payload", () => {
    const result = parseTelegramVerificationCallbackValue("invalid");
    expect(result.ok).toBe(false);
  });
});

describe("group verification button press by another member", () => {
  const ANOTHER_USER_ID = "99999999";

  beforeEach(() => {
    resetDemoVoterBindings();
    resetDemoWorkflowData();
    demoMembers.clear();
    demoMembers.set(ownerMember.id, ownerMember);
  });

  test("button press from another group member is rejected with no state change", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const callbackValue = buildTelegramVerificationCallbackValue({
      verificationNonce: createResult.verificationNonce,
      telegramUserId: TELEGRAM_USER_ID,
    });

    const bindingBefore = await getVoterBinding(
      DEMO_ORG_ID,
      "telegram",
      TENANT_CHANNEL_ID,
      TELEGRAM_USER_ID
    );
    expect(bindingBefore?.status).toBe("pending");

    const result = await handleTelegramVerificationConfirm({
      callbackValue,
      presserTelegramUserId: ANOTHER_USER_ID,
      expectedChannelKey: TENANT_CHANNEL_ID,
      expectedOrgId: DEMO_ORG_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("user_mismatch");
      expect(result.messageJa).toBe("このボタンはあなた宛てではありません。");
    }

    const bindingAfter = await getVoterBinding(
      DEMO_ORG_ID,
      "telegram",
      TENANT_CHANNEL_ID,
      TELEGRAM_USER_ID
    );
    expect(bindingAfter?.status).toBe("pending");
    expect(bindingAfter?.verifiedAt).toBeFalsy();
  });

  test("button press from the correct user activates the binding", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "telegram",
      channelKey: TENANT_CHANNEL_ID,
      externalUserId: TELEGRAM_USER_ID,
      memberId: OWNER_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const callbackValue = buildTelegramVerificationCallbackValue({
      verificationNonce: createResult.verificationNonce,
      telegramUserId: TELEGRAM_USER_ID,
    });

    const result = await handleTelegramVerificationConfirm({
      callbackValue,
      presserTelegramUserId: TELEGRAM_USER_ID,
      expectedChannelKey: TENANT_CHANNEL_ID,
      expectedOrgId: DEMO_ORG_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.status).toBe("active");
      expect(result.messageJa).toContain("正常に登録");
    }

    const bindingAfter = await getVoterBinding(
      DEMO_ORG_ID,
      "telegram",
      TENANT_CHANNEL_ID,
      TELEGRAM_USER_ID
    );
    expect(bindingAfter?.status).toBe("active");
    expect(bindingAfter?.verifiedAt).toBeDefined();
  });
});

describe("callback_data 64-byte limit", () => {
  test("buildTelegramVerificationCallbackValue produces compact callback_data", async () => {
    const { generateVerificationNonce } = await import("./voter-binding");
    const { buildTelegramVerificationCallbackValue } = await import("./telegram-binding-verification");

    const nonce = generateVerificationNonce();
    const callbackValue = buildTelegramVerificationCallbackValue({
      verificationNonce: nonce,
      telegramUserId: TELEGRAM_USER_ID,
    });

    expect(callbackValue.length).toBeLessThanOrEqual(50);
    expect(callbackValue.split(".")).toHaveLength(3);
  });

  test("callback_data with prefix stays under 64 bytes", async () => {
    const { generateVerificationNonce } = await import("./voter-binding");
    const {
      buildTelegramVerificationCallbackValue,
      TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    } = await import("./telegram-binding-verification");

    const nonce = generateVerificationNonce();
    const callbackValue = buildTelegramVerificationCallbackValue({
      verificationNonce: nonce,
      telegramUserId: TELEGRAM_USER_ID,
    });

    const confirmData = `vb:c:${callbackValue}`;
    const rejectData = `vb:r:${callbackValue}`;

    expect(Buffer.byteLength(confirmData, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    expect(Buffer.byteLength(rejectData, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  test("callback_data stays under 64 bytes with long telegram user IDs", async () => {
    const { generateVerificationNonce } = await import("./voter-binding");
    const {
      buildTelegramVerificationCallbackValue,
      TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    } = await import("./telegram-binding-verification");

    const longUserIds = ["12345678", "123456789012", "1234567890123456", "99999999999999999999"];

    for (const userId of longUserIds) {
      const nonce = generateVerificationNonce();
      const callbackValue = buildTelegramVerificationCallbackValue({
        verificationNonce: nonce,
        telegramUserId: userId,
      });

      const confirmData = `vb:c:${callbackValue}`;
      const byteLen = Buffer.byteLength(confirmData, "utf8");
      expect(byteLen).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  test("multiple nonces produce different callback values", async () => {
    const { generateVerificationNonce } = await import("./voter-binding");
    const { buildTelegramVerificationCallbackValue } = await import("./telegram-binding-verification");

    const nonce1 = generateVerificationNonce();
    const nonce2 = generateVerificationNonce();

    const cb1 = buildTelegramVerificationCallbackValue({
      verificationNonce: nonce1,
      telegramUserId: TELEGRAM_USER_ID,
    });
    const cb2 = buildTelegramVerificationCallbackValue({
      verificationNonce: nonce2,
      telegramUserId: TELEGRAM_USER_ID,
    });

    expect(cb1).not.toBe(cb2);
  });
});
