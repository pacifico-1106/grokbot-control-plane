/**
 * P0 Item 5: Slack voter binding tests.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { isSlackUserAuthorizedForApproval } from "./slack-voter";
import { setDemoWorkflowVoterBinding, resetDemoWorkflowData } from "./data";

const ORG_ID = "org_slack_voter_test";
const CHANNEL_ID = "chn_slack_test";
const VOTER_1 = "U_VOTER_1";
const VOTER_2 = "U_VOTER_2";
const MEMBER_ID = "member_uuid_123";

describe("isSlackUserAuthorizedForApproval (non-strict mode)", () => {
  beforeEach(() => {
    resetDemoWorkflowData();
  });

  afterEach(() => {
    resetDemoWorkflowData();
  });

  test("allows any user when allowedUserIds is empty", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [],
      false
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("no_restrictions");
  });

  test("allows user when in allowedUserIds", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [VOTER_1, VOTER_2],
      false
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("in_allowed_user_ids");
  });

  test("rejects user when not in allowedUserIds", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [VOTER_2],
      false
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("not_in_allowed_user_ids");
  });
});

describe("isSlackUserAuthorizedForApproval (strict mode)", () => {
  beforeEach(() => {
    resetDemoWorkflowData();
  });

  afterEach(() => {
    resetDemoWorkflowData();
  });

  test("allows user when in allowedUserIds (strict mode)", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [VOTER_1, VOTER_2],
      true
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("in_allowed_user_ids");
  });

  test("rejects user without allowedUserIds or voter binding", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [],
      true
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("strict_mode_requires_allowed_user_ids_or_voter_binding");
  });

  test("allows user with valid voter binding", async () => {
    setDemoWorkflowVoterBinding({
      orgId: ORG_ID,
      provider: "slack",
      channelKey: CHANNEL_ID,
      userId: VOTER_1,
      memberId: MEMBER_ID,
      verifiedAt: new Date().toISOString(),
    });

    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [],
      true
    );
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("demo_voter_binding");
  });

  test("rejects user with expired voter binding", async () => {
    const expiredDate = new Date(Date.now() - 1000).toISOString();
    setDemoWorkflowVoterBinding({
      orgId: ORG_ID,
      provider: "slack",
      channelKey: CHANNEL_ID,
      userId: VOTER_1,
      memberId: MEMBER_ID,
      expiresAt: expiredDate,
    });

    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [],
      true
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("strict_mode_requires_allowed_user_ids_or_voter_binding");
  });

  test("rejects user with revoked voter binding", async () => {
    setDemoWorkflowVoterBinding({
      orgId: ORG_ID,
      provider: "slack",
      channelKey: CHANNEL_ID,
      userId: VOTER_1,
      memberId: MEMBER_ID,
      revoked: true,
    });

    const result = await isSlackUserAuthorizedForApproval(
      ORG_ID,
      CHANNEL_ID,
      VOTER_1,
      [],
      true
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("strict_mode_requires_allowed_user_ids_or_voter_binding");
  });
});

/**
 * Tenant-agnostic invariant tests.
 * These tests must pass for any org fixture and verify security invariants.
 */
describe("INVARIANT: Cross-org voter isolation (Slack)", () => {
  const ORG_A = "fixture_org_a";
  const ORG_B = "fixture_org_b";
  const CHANNEL_A = "chn_fixture_a";
  const USER_ORG_A = "U_ORG_A_USER";
  const USER_ORG_B = "U_ORG_B_USER";
  const MEMBER_A = "member_fixture_a";

  beforeEach(() => {
    resetDemoWorkflowData();
  });

  afterEach(() => {
    resetDemoWorkflowData();
  });

  test("INVARIANT: voter binding in org B is not valid for org A (strict mode)", async () => {
    setDemoWorkflowVoterBinding({
      orgId: ORG_B,
      provider: "slack",
      channelKey: CHANNEL_A,
      userId: USER_ORG_B,
      memberId: MEMBER_A,
      verifiedAt: new Date().toISOString(),
    });

    const result = await isSlackUserAuthorizedForApproval(
      ORG_A,
      CHANNEL_A,
      USER_ORG_B,
      [],
      true
    );
    expect(result.authorized).toBe(false);
  });

  test("INVARIANT: user not in allowedUserIds cannot vote regardless of org", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_A,
      CHANNEL_A,
      USER_ORG_B,
      [USER_ORG_A],
      false
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("not_in_allowed_user_ids");
  });

  test("INVARIANT: strict mode with no allowedUserIds and no binding rejects all", async () => {
    const result = await isSlackUserAuthorizedForApproval(
      ORG_A,
      CHANNEL_A,
      USER_ORG_A,
      [],
      true
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("strict_mode_requires_allowed_user_ids_or_voter_binding");
  });
});
