/**
 * Tests for voter binding registration and identity verification.
 * P0 Item 2: Voter binding registration + identity verification
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
const DEMO_MEMBER_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000099";

const baseMember: OrgMember = {
  id: DEMO_MEMBER_ID,
  orgId: DEMO_ORG_ID,
  email: "approver@example.com",
  displayName: "Test Approver",
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
  revokeVoterBinding,
  listVoterBindings,
  getVoterBinding,
  checkSetupApproverBindingStatus,
  resetDemoVoterBindings,
  generateVerificationCode,
  hashVerificationCode,
} = await import("./voter-binding");

describe("voter binding registration", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(baseMember.id, baseMember);
  });

  test("createPendingVoterBinding creates pending binding with verification code", async () => {
    const result = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.status).toBe("pending");
      expect(result.binding.verifiedAt).toBeNull();
      expect(result.verificationCode).toMatch(/^\d{6}$/);
      expect(result.binding.expiresAt).toBeDefined();
    }
  });

  test("cross-org invariant: member must belong to same org as channel", async () => {
    const otherOrgMember: OrgMember = {
      ...baseMember,
      id: "other-member-id",
      orgId: OTHER_ORG_ID,
    };
    demoMembers.set(otherOrgMember.id, otherOrgMember);

    const result = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: "other-member-id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cross_org|member_not_found/);
    }
  });

  test("inactive member cannot be bound", async () => {
    const inactiveMember: OrgMember = {
      ...baseMember,
      id: "inactive-member",
      status: "disabled",
    };
    demoMembers.set(inactiveMember.id, inactiveMember);

    const result = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: "inactive-member",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("member_not_active");
    }
  });

  test("verifyVoterBinding activates binding with correct code", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      verificationCode: createResult.verificationCode,
      teamId: "T_WORKSPACE",
    });

    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      expect(verifyResult.binding.status).toBe("active");
      expect(verifyResult.binding.verifiedAt).toBeDefined();
      expect(verifyResult.binding.teamId).toBe("T_WORKSPACE");
    }
  });

  test("verifyVoterBinding rejects incorrect code", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      verificationCode: "000000",
    });

    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("invalid_verification_code");
    }
  });

  test("revokeVoterBinding marks binding as revoked", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      verificationCode: createResult.verificationCode,
    });

    const revokeResult = await revokeVoterBinding(
      DEMO_ORG_ID,
      "slack",
      "channel-123",
      "U_SLACK_123"
    );

    expect(revokeResult.ok).toBe(true);

    const binding = await getVoterBinding(
      DEMO_ORG_ID,
      "slack",
      "channel-123",
      "U_SLACK_123"
    );

    expect(binding?.status).toBe("revoked");
  });

  test("listVoterBindings filters by status", async () => {
    await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-1",
      externalUserId: "U1",
      memberId: DEMO_MEMBER_ID,
    });

    const createResult2 = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-2",
      externalUserId: "U2",
      memberId: DEMO_MEMBER_ID,
    });

    if (createResult2.ok) {
      await verifyVoterBinding({
        orgId: DEMO_ORG_ID,
        provider: "slack",
        channelKey: "channel-2",
        externalUserId: "U2",
        verificationCode: createResult2.verificationCode,
      });
    }

    const allBindings = await listVoterBindings({ orgId: DEMO_ORG_ID });
    expect(allBindings.length).toBe(2);

    const activeBindings = allBindings.filter((b) => b.status === "active");
    expect(activeBindings.length).toBe(1);
    expect(activeBindings[0].externalUserId).toBe("U2");
  });

  test("checkSetupApproverBindingStatus reports correct state", async () => {
    let status = await checkSetupApproverBindingStatus(DEMO_ORG_ID);
    expect(status.hasActiveBindings).toBe(false);
    expect(status.hasPendingBindings).toBe(false);
    expect(status.activeCount).toBe(0);

    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
    });

    status = await checkSetupApproverBindingStatus(DEMO_ORG_ID);
    expect(status.hasPendingBindings).toBe(true);
    expect(status.hasActiveBindings).toBe(false);
    expect(status.pendingCount).toBe(1);

    if (createResult.ok) {
      await verifyVoterBinding({
        orgId: DEMO_ORG_ID,
        provider: "slack",
        channelKey: "channel-123",
        externalUserId: "U_SLACK_123",
        verificationCode: createResult.verificationCode,
      });
    }

    status = await checkSetupApproverBindingStatus(DEMO_ORG_ID);
    expect(status.hasActiveBindings).toBe(true);
    expect(status.activeCount).toBe(1);
  });
});

describe("verification code generation", () => {
  test("generateVerificationCode produces 6-digit code", () => {
    const code = generateVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  test("hashVerificationCode produces consistent hash", () => {
    const code = "123456";
    const secret = "test-secret";
    const hash1 = hashVerificationCode(code, secret);
    const hash2 = hashVerificationCode(code, secret);
    expect(hash1).toBe(hash2);
  });

  test("hashVerificationCode produces different hash for different codes", () => {
    const secret = "test-secret";
    const hash1 = hashVerificationCode("123456", secret);
    const hash2 = hashVerificationCode("654321", secret);
    expect(hash1).not.toBe(hash2);
  });
});

describe("expiry handling", () => {
  test("expired binding is marked as expired status", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
      expiresInDays: -1,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      verificationCode: createResult.verificationCode,
    });

    const binding = await getVoterBinding(
      DEMO_ORG_ID,
      "slack",
      "channel-123",
      "U_SLACK_123"
    );

    expect(binding?.status).toBe("expired");
  });

  test("listVoterBindings excludes expired by default", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
      expiresInDays: -1,
    });

    if (createResult.ok) {
      await verifyVoterBinding({
        orgId: DEMO_ORG_ID,
        provider: "slack",
        channelKey: "channel-123",
        externalUserId: "U_SLACK_123",
        verificationCode: createResult.verificationCode,
      });
    }

    const bindings = await listVoterBindings({ orgId: DEMO_ORG_ID });
    expect(bindings.length).toBe(0);

    const allBindings = await listVoterBindings({
      orgId: DEMO_ORG_ID,
      includeExpired: true,
    });
    expect(allBindings.length).toBe(1);
    expect(allBindings[0].status).toBe("expired");
  });
});

describe("external team user rejection (Slack Connect)", () => {
  test("team_id mismatch during verification rejects binding", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      memberId: DEMO_MEMBER_ID,
      teamId: "T_EXPECTED",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: DEMO_ORG_ID,
      provider: "slack",
      channelKey: "channel-123",
      externalUserId: "U_SLACK_123",
      verificationCode: createResult.verificationCode,
      teamId: "T_EXTERNAL_WORKSPACE",
    });

    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("team_id_mismatch");
    }
  });
});
