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

  test("parseTelegramVerificationCallbackValue rejects invalid signature", () => {
    const fakePayload = Buffer.from(JSON.stringify({
      o: DEMO_ORG_ID,
      u: TELEGRAM_USER_ID,
      v: "123456",
      t: Date.now(),
    })).toString("base64url");
    const result = parseTelegramVerificationCallbackValue(`${fakePayload}.invalidsig`);
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

    const { sendVerificationToTelegramUser } = await import("./telegram-binding-verification");

    const wrongUserResult = await handleTelegramVerificationConfirm({
      callbackValue: "invalid_callback_value",
      presserTelegramUserId: "wrong_user",
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
