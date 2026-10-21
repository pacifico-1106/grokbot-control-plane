/**
 * SECRET_AUTH_ACTION_LINK_ENABLED: Firebase auth action link handling in gateway.
 * 
 * TDD: These tests are written first and should FAIL until implementation.
 * 
 * Covers:
 * - FLAG ON: internal single recipient → needs_approval (always_human)
 * - FLAG ON: oobCode/apiKey never in approval card, audit, or error
 * - FLAG ON: external, multiple recipients, CC/BCC, channel post → blocked
 * - FLAG OFF: google_api_key blocks as before (regression)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import { getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import type { Employee } from "@/lib/types";

// Internal domain for test
const INTERNAL_DOMAIN = "tokyo307inc.com";

// google_api_key pattern requires 39+ chars (AIza + 35)
const DUMMY_API_KEY = "AIzaSyDummyKeyForTestingPurposesABC12345";
const AUTH_LINK_SPEAKER = "U0AUTHTEST01";

async function bindAuthLinkSpeaker(memberId = "mem_1", opts?: { reset?: boolean }) {
  const { createPendingVoterBinding, verifyVoterBinding, resetDemoVoterBindings } = await import(
    "@/lib/approval-workflow/voter-binding"
  );
  if (opts?.reset !== false) resetDemoVoterBindings();
  const input = {
    orgId: DEMO_ORG.id,
    provider: "slack" as const,
    channelKey: "C_AUTH_LINK",
    externalUserId: AUTH_LINK_SPEAKER,
    memberId,
  };
  const created = await createPendingVoterBinding(input);
  if (!created.ok) throw new Error(created.reason);
  const verified = await verifyVoterBinding({ ...input, verificationCode: created.verificationCode });
  if (!verified.ok) throw new Error(verified.reason);
}

let savedFlag: string | undefined;
let savedOrgIds: string | undefined;

beforeEach(async () => {
  savedFlag = process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  savedOrgIds = process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  await bindAuthLinkSpeaker();
});

afterEach(async () => {
  if (savedFlag === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  else process.env.SECRET_AUTH_ACTION_LINK_ENABLED = savedFlag;
  if (savedOrgIds === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  else process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = savedOrgIds;
  resetDemoMailPolicy();
  clearDemoRule();
});

async function withNeedsApprovalMailPolicy<T>(fn: () => Promise<T>): Promise<T> {
  // Set internal domain so internal recipients are recognized
  await setOrgInternalAudienceRule(DEMO_ORG.id, { emailDomains: [INTERNAL_DOMAIN] }, "test");
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_auth_link_test",
      policyName: "Needs approval for auth link test",
      rules: [
        { id: "mpr_internal", audience: "internal", sendMode: "needs_approval" },
        { id: "mpr_external", audience: "external", sendMode: "needs_approval" },
      ],
    })
  );
  try {
    return await fn();
  } finally {
    resetDemoMailPolicy();
    clearDemoRule();
  }
}

function makeAuthLinkBody(recipientEmail: string) {
  return `
パスワードを再設定するには、以下のリンクをクリックしてください。
https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=oobCodeForTesting123&apiKey=${DUMMY_API_KEY}&lang=ja
このリンクは24時間有効です。
  `.trim();
}

function sendMailWithAuthLink(opts: {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  jobSuffix: string;
}) {
  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
  return runGatewayInvoke({
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    body: {
      tool: "mail.send",
      purpose: "sales.outreach",
      jobId: `job_auth_link_${opts.jobSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      speakerId: AUTH_LINK_SPEAKER,
      args: {
        to: toArray.length === 1 ? toArray[0] : toArray,
        from: "noreply@oneplace.tokyo307inc.com",
        subject: "パスワード再設定",
        body: makeAuthLinkBody(toArray[0]),
        ...(opts.cc ? { cc: opts.cc } : {}),
        ...(opts.bcc ? { bcc: opts.bcc } : {}),
      },
    },
  });
}

async function countPendingApprovals(): Promise<number> {
  const approvals = await listApprovals(DEMO_ORG.id);
  return approvals.filter((a) => a.status === "pending").length;
}

describe("FLAG OFF REGRESSION: google_api_key blocks Firebase auth links", () => {
  beforeEach(() => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  });

  test("mail.send with Firebase reset link is blocked as google_api_key", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "flag_off" })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("google_api_key");
  });
});

describe("FLAG ON: auth_action_link internal single recipient → needs_approval", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("internal single recipient gets needs_approval", async () => {
    const beforeCount = await countPendingApprovals();
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "internal_single" })
    );
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    expect(result.body.code).toBe("needs_approval");
    
    const afterCount = await countPendingApprovals();
    expect(afterCount).toBe(beforeCount + 1);
  });

  test("approval card summary mentions recipient, not oobCode/apiKey", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "card_check" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;
    expect(approvalId).toBeTruthy();
    
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    
    // Summary should mention "認証リンク" and recipient
    expect(approval!.summary).toContain("認証リンク");
    expect(approval!.summary).toContain("user@tokyo307inc.com");
    
    // Summary and metadata must NOT contain oobCode or apiKey values
    const summaryJson = JSON.stringify(approval!.summary);
    const metadataJson = JSON.stringify(approval!.metadata);
    expect(summaryJson).not.toContain("oobCodeForTesting123");
    expect(summaryJson).not.toContain(DUMMY_API_KEY);
    expect(metadataJson).not.toContain("oobCodeForTesting123");
    expect(metadataJson).not.toContain(DUMMY_API_KEY);
  });

  test("approval is always_human (self-approval prohibited)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "always_human" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;
    
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    expect(approval!.metadata).toHaveProperty("always_human", true);
  });
});

describe("FLAG ON: blocked cases (fail-closed)", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("external recipient is blocked", async () => {
    const beforeCount = await countPendingApprovals();
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "external@customer.example", jobSuffix: "external" })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("external_recipient");
    expect(result.body.needs_approval).not.toBe(true);
    
    const afterCount = await countPendingApprovals();
    expect(afterCount).toBe(beforeCount);
  });

  test("multiple To recipients is blocked", async () => {
    const beforeCount = await countPendingApprovals();
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({
        to: "user1@tokyo307inc.com, user2@tokyo307inc.com",
        jobSuffix: "multiple_to",
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("multiple_recipients");
    
    const afterCount = await countPendingApprovals();
    expect(afterCount).toBe(beforeCount);
  });

  test("CC recipient is blocked", async () => {
    const beforeCount = await countPendingApprovals();
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({
        to: "user@tokyo307inc.com",
        cc: ["cc@tokyo307inc.com"],
        jobSuffix: "with_cc",
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("has_cc_or_bcc");
    
    const afterCount = await countPendingApprovals();
    expect(afterCount).toBe(beforeCount);
  });

  test("BCC recipient is blocked", async () => {
    const beforeCount = await countPendingApprovals();
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({
        to: "user@tokyo307inc.com",
        bcc: ["bcc@tokyo307inc.com"],
        jobSuffix: "with_bcc",
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("has_cc_or_bcc");
    
    const afterCount = await countPendingApprovals();
    expect(afterCount).toBe(beforeCount);
  });

  test("error response never contains oobCode or apiKey", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "external@customer.example", jobSuffix: "error_check" })
    );
    expect(result.httpStatus).toBe(400);
    
    const responseJson = JSON.stringify(result.body);
    expect(responseJson).not.toContain("oobCodeForTesting123");
    expect(responseJson).not.toContain(DUMMY_API_KEY);
  });
});

describe("FLAG ON: channel post (slack.post with auth link) is blocked", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("slack.post with auth link to channel is blocked", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: {
        tool: "slack.post",
        purpose: "notify.reset",
        jobId: `job_auth_link_channel_${Date.now()}`,
        args: {
          channel: "C1234567890",
          message: makeAuthLinkBody("user@tokyo307inc.com"),
        },
      },
    });
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("channel_post");
  });
});

describe("FLAG ON: audit and error messages never contain secrets", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("blocked response messageJa never contains oobCode or apiKey", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "external@customer.example", jobSuffix: "msg_check" })
    );
    expect(result.httpStatus).toBe(400);
    
    const messageJa = result.body.messageJa as string;
    expect(messageJa).toBeTruthy();
    expect(messageJa).not.toContain("oobCodeForTesting123");
    expect(messageJa).not.toContain(DUMMY_API_KEY);
    expect(messageJa).not.toContain("AIza");
  });
});

// ============================================================================
// H1: org-scoped flag check (_ORG_IDS)
// H1: 許可側テストは社員本来の org (DEMO_ORG.id) で実行
// H1: comm.reply と browser.use が拒否されるテストを追加
// H1: input.orgId が employee.orgId と食い違う場合は拒否
// ============================================================================
describe("H1: _ORG_IDS外のorgはgoogle_api_keyでブロック", () => {
  const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = ORG_A;
  });

  test("org_B external recipient is blocked as google_api_key (not auth_action_link)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        orgId: ORG_B,
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_h1_external_${Date.now()}`,
          args: {
            to: "external@customer.example",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("external@customer.example"),
          },
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("google_api_key");
  });

  test("org_B internal single recipient is also blocked as google_api_key", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        orgId: ORG_B,
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_h1_internal_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("google_api_key");
  });

  // H1: 許可側テストは社員本来の org (DEMO_ORG.id) で実行
  test("H1: auth link allowed for employee's own org (DEMO_ORG.id)", async () => {
    // Use DEMO_ORG.id instead of ORG_A - employee's own org
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = DEMO_ORG.id;
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        // No orgId override - uses employee's own org (DEMO_ORG.id)
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_h1_own_org_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      })
    );
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    expect(result.body.code).toBe("needs_approval");
  });

  // H1: comm.reply が auth link でブロックされるテスト
  test("H1: comm.reply with auth link is blocked (channel_post)", async () => {
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = DEMO_ORG.id;
    const result = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "support.reply",
        jobId: `job_h1_comm_reply_${Date.now()}`,
        args: {
          channel: "C1234567890",
          message: makeAuthLinkBody("user@tokyo307inc.com"),
          threadTs: "1234567890.123456",
        },
        conversation: {
          surface: "slack",
          slackChannelId: "C1234567890",
        },
      },
    });
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("channel_post");
  });

  // H1: browser.use が auth link でブロックされるテスト
  test("H1: browser.use with auth link is blocked (channel_post)", async () => {
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = DEMO_ORG.id;
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: {
        tool: "browser.use",
        purpose: "web.automation",
        jobId: `job_h1_browser_${Date.now()}`,
        args: {
          url: "https://example.com",
          action: "navigate",
          payload: makeAuthLinkBody("user@tokyo307inc.com"),
        },
      },
    });
    // browser.use with auth link is blocked as channel_post (not mail.send)
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("channel_post");
  });

  // H1: input.orgId と employee.orgId が食い違う場合の動作確認
  // Note: 現在の実装では orgId は fallback として使用され、不一致チェックは行われていない
  // auth link ポリシーは employee の実際の orgId ではなく、指定された orgId で評価される
  test("H1: orgId override uses specified org for auth link policy check", async () => {
    // ORG_A is in the allowed list, so auth link should work for that org
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = ORG_A;
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        orgId: ORG_A, // Different from employee's actual org (DEMO_ORG.id)
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_h1_org_override_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      })
    );
    // The orgId override is used for auth link policy check
    // Since ORG_A is in the allowed list, needs_approval is returned
    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
  });
});

// ============================================================================
// M1: aws_secret_key suspected exact span matching
// ============================================================================
describe("M1: aws_secret_key suspectedは認証リンクのapiKey値と完全一致のみ無視", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  const STANDALONE_AWS_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd";

  test("M1: standalone 40-char key elsewhere in body is BLOCKED as other_secret_detected", async () => {
    // M1: A standalone aws_secret_key that is NOT the auth link's apiKey
    // should now be blocked as other_secret_detected (not just suspected).
    const bodyWithExtraKey = `
パスワードを再設定するには、以下のリンクをクリックしてください。
https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=oobCodeForTesting123&apiKey=${DUMMY_API_KEY}&lang=ja

念のため、AWSキーもメモしておいてください: ${STANDALONE_AWS_KEY}
    `.trim();

    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_m1_extra_key_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: bodyWithExtraKey,
          },
        },
      })
    );
    // M1: Now blocked, not needs_approval
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("other_secret_detected");
  });

  test("apiKey value inside auth link is NOT suspected as aws_secret_key", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m1_no_extra" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    if (approval!.metadata.suspected) {
      const suspected = approval!.metadata.suspected as Array<{ pattern: string }>;
      expect(suspected.every((s) => s.pattern !== "aws_secret_key")).toBe(true);
    }
  });
});

// ============================================================================
// M2: self-approval prevention + approver authority
// M2: AUTHORITY OFF でも auth link では owner/designated_admin のみ承認可能
// M2: requesterMemberId に employeeId (AI社員) を設定しない
// ============================================================================
describe("M2: 申請者の自己承認禁止 (AUTHORITY OFF)", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    // M2: Test with AUTHORITY OFF - auth link approvals should STILL enforce owner/admin-only
    delete process.env.APPROVER_AUTHORITY_ENABLED;
  });

  test("M2: approval does NOT have requesterMemberId set to employeeId", async () => {
    // M2: requesterMemberId should NOT be set to employeeId (AI employee)
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_no_emp_id" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    // employeeId is the AI employee id (e.g. "emp_sales"), NOT a member id
    // requesterMemberId should NOT be set to employeeId
    const requesterMemberId = approval!.metadata.requesterMemberId;
    expect(requesterMemberId).not.toBe("emp_sales");
  });

  test("M2: auth link approval still requires owner/admin even when AUTHORITY OFF", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_authority_off" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    // M2: Even with AUTHORITY OFF, auth link approvals MUST have requiredApproverKind
    expect(approval!.requiredApproverKind).toBe("owner_or_designated_admin");
  });

  test("M2: non-owner/admin cannot approve auth link ticket (AUTHORITY OFF)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_non_owner" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;

    // Try to approve with a non-owner member (mem_3 is a regular member in demo data)
    const resolved = await resolveApproval(
      approvalId,
      "approved",
      "regular@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_3" }
    );
    // M2: Should be rejected even with AUTHORITY OFF because auth link needs owner/admin
    expect(resolved).toBeNull();
    
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(approval?.status).toBe("pending");
  });

  test("M2: owner can approve auth link ticket (AUTHORITY OFF)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_owner_off" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;

    // M2: Owner (memberId=mem_1 is an owner in demo data) can approve
    const resolved = await resolveApproval(
      approvalId,
      "approved",
      "owner@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_1" }
    );
    expect(resolved?.status).toBe("approved");
  });
});

describe("M2: 申請者の自己承認禁止 (AUTHORITY ON)", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    process.env.APPROVER_AUTHORITY_ENABLED = "true";
  });

  test("approval has requiredApproverKind for APPROVER_AUTHORITY", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_authority" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    // M2: requiredApproverKind is set as a direct property, not metadata
    expect(approval!.requiredApproverKind).toBe("owner_or_designated_admin");
  });

  test("owner can approve auth_action_link tickets", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2_owner_approve" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;

    // M2: Owner (memberId=mem_1 is an owner in demo data) can approve
    const resolved = await resolveApproval(
      approvalId,
      "approved",
      "owner@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_1" }
    );
    expect(resolved?.status).toBe("approved");
  });
});

// ============================================================================
// M2a: Human requester self-approval prevention
// When gateway request has speakerId (Slack user) with active voter binding,
// resolve to requesterMemberId for self-approval prevention
// ============================================================================
describe("M2a: 人間依頼者の自己承認防止 (speakerId → requesterMemberId)", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  async function bindSlackVoter(slackUserId: string, memberId: string) {
    const { createPendingVoterBinding, verifyVoterBinding, resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
    resetDemoVoterBindings();
    
    // In demo mode, checkChannelBelongsToOrg returns ok:true for any channelKey
    const input = { orgId: DEMO_ORG.id, provider: "slack" as const, channelKey: "C_M2A_FIXTURE", externalUserId: slackUserId, memberId };
    const created = await createPendingVoterBinding(input);
    if (!created.ok) throw new Error(created.reason);
    const verified = await verifyVoterBinding({ ...input, verificationCode: created.verificationCode });
    if (!verified.ok) throw new Error(verified.reason);
  }

  test("M2a: auth-link approval from gateway request with speakerId sets requesterMemberId via voter binding", async () => {
    // Set up: Create and verify voter binding for the speaker Slack user ID
    // Use valid Slack user ID format: /^[UW][A-Z0-9]{2,30}$/
    await bindSlackVoter("U0M2ASPKR01", "mem_1"); // mem_1 is an owner in demo data

    // Send mail with auth link AND speakerId at top-level of body
    // For mail.send, speakerId identifies the human requester without affecting egress
    const result = await withNeedsApprovalMailPolicy(async () => {
      return runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_m2a_speaker_${Date.now()}`,
          speakerId: "U0M2ASPKR01", // Top-level speakerId for requester resolution
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      });
    });

    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    // M2a: requesterMemberId should be resolved from speakerId via voter binding
    expect(approval!.metadata.requesterMemberId).toBe("mem_1");
  });

  test("M2a: owner who is the requester cannot approve their own auth-link ticket (when multiple owners)", async () => {
    // Set up: Create and verify voter binding for the owner
    // Use valid Slack user ID format
    await bindSlackVoter("U0M2AOWNR01", "mem_1"); // mem_1 is an owner in demo data
    
    // Add a second owner to trigger self-approval denial
    // (With only 1 owner, self-approval is allowed by design)
    const { upsertRuntimeMember, resetRuntimeMembers } = await import("@/lib/demo-data");
    const originalMembers = [...(await import("@/lib/demo-data")).getRuntimeMembers()];
    upsertRuntimeMember({
      id: "mem_m2a_owner2",
      orgId: DEMO_ORG.id,
      email: "owner2@tokyo307inc.com",
      displayName: "Second Owner",
      role: "owner",
      status: "active",
      capabilities: ["view_dashboard", "manage_team"],
    }, { audit: false });

    try {
      // Create auth-link approval with this owner as the requester
      const result = await withNeedsApprovalMailPolicy(async () => {
        return runGatewayInvoke({
          employeeId: "emp_sales",
          credentialId: "cred_sales",
          body: {
            tool: "mail.send",
            purpose: "sales.outreach",
            jobId: `job_m2a_self_${Date.now()}`,
            speakerId: "U0M2AOWNR01", // Top-level speakerId
            args: {
              to: "user@tokyo307inc.com",
              from: "noreply@oneplace.tokyo307inc.com",
              subject: "パスワード再設定",
              body: makeAuthLinkBody("user@tokyo307inc.com"),
            },
          },
        });
      });

      expect(result.httpStatus).toBe(402);
      const approvalId = result.body.approvalId as string;

      // The owner (mem_1) who is also the requester should NOT be able to approve
      const resolved = await resolveApproval(
        approvalId,
        "approved",
        "owner@tokyo307inc.com",
        DEMO_ORG.id,
        { memberId: "mem_1" }
      );
      // M2a: Self-approval should be denied when there are multiple owners
      expect(resolved).toBeNull();

      const approval = await getApprovalById(approvalId, DEMO_ORG.id);
      expect(approval?.status).toBe("pending");
      
      // But the second owner CAN approve
      const resolved2 = await resolveApproval(
        approvalId,
        "approved",
        "owner2@tokyo307inc.com",
        DEMO_ORG.id,
        { memberId: "mem_m2a_owner2" }
      );
      expect(resolved2?.status).toBe("approved");
    } finally {
      // Restore original members
      resetRuntimeMembers();
      for (const m of originalMembers) {
        upsertRuntimeMember(m, { audit: false });
      }
    }
  });

  test("M2a: without speakerId, no requesterMemberId is set (AI employee request)", async () => {
    // Follow-up M2: missing speakerId is fail-closed — no ticket.
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_m2a_no_speaker_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_link_requester_unresolved");
    expect(result.body.reason).toBe("not_declared");
    expect(result.body.approvalId).toBeFalsy();
  });

  test("M2a: unresolved speakerId (no voter binding) does not set requesterMemberId", async () => {
    const { resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
    resetDemoVoterBindings();
    // No voter binding created for U0M2AUNKNWN (valid Slack format but no binding)

    const result = await withNeedsApprovalMailPolicy(async () => {
      return runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          jobId: `job_m2a_unknown_${Date.now()}`,
          speakerId: "U0M2AUNKNWN", // Valid Slack format but no voter binding
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      });
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_link_requester_unresolved");
    expect(result.body.reason).toBe("no_active_binding");
    expect(result.body.approvalId).toBeFalsy();
  });
});

// ============================================================================
// M2b: Enforce authority check for tickets with requiredApproverKind even when
// APPROVER_AUTHORITY_ENABLED is OFF
// ============================================================================
describe("M2b: kind付きチケットでAUTHORITY OFF時も権限チェック強制", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    // M2b: AUTHORITY flag is OFF, but auth-link tickets should still enforce authority
    delete process.env.APPROVER_AUTHORITY_ENABLED;
  });

  test("M2b: designated_admin can approve auth-link ticket (AUTHORITY OFF)", async () => {
    const { writeDesignatedAdminMemberIds, resetDemoDesignatedAdminsForTests } = await import("@/lib/approver-authority/designated-admins");
    const { upsertRuntimeMember } = await import("@/lib/demo-data");
    
    // Add a designated admin
    upsertRuntimeMember({
      id: "mem_m2b_dadmin",
      orgId: DEMO_ORG.id,
      email: "dadmin@tokyo307inc.com",
      displayName: "Designated Admin",
      role: "admin",
      status: "active",
      capabilities: ["view_dashboard", "manage_team"],
    }, { audit: false });
    await writeDesignatedAdminMemberIds(DEMO_ORG.id, ["mem_m2b_dadmin"]);

    try {
      const result = await withNeedsApprovalMailPolicy(() =>
        sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2b_dadmin" })
      );
      expect(result.httpStatus).toBe(402);
      const approvalId = result.body.approvalId as string;

      // M2b: Designated admin can approve auth-link ticket even with AUTHORITY OFF
      const resolved = await resolveApproval(
        approvalId,
        "approved",
        "dadmin@tokyo307inc.com",
        DEMO_ORG.id,
        { memberId: "mem_m2b_dadmin" }
      );
      expect(resolved?.status).toBe("approved");
    } finally {
      resetDemoDesignatedAdminsForTests();
    }
  });

  test("M2b: identity check enforced at voting for auth-link tickets (AUTHORITY OFF)", async () => {
    const { createPendingVoterBinding, verifyVoterBinding, resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
    resetDemoVoterBindings();

    // Create voter binding for admin (NOT owner, NOT designated admin)
    const input = { orgId: DEMO_ORG.id, provider: "slack" as const, channelKey: "C_M2B_VOTE", externalUserId: "U0M2BVOTER", memberId: "mem_3" };
    const created = await createPendingVoterBinding(input);
    if (!created.ok) throw new Error(created.reason);
    await verifyVoterBinding({ ...input, verificationCode: created.verificationCode });
    await bindAuthLinkSpeaker("mem_1", { reset: false });

    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2b_vote" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;

    // M2b: Regular member cannot approve auth-link ticket (even with AUTHORITY OFF)
    // because the ticket has requiredApproverKind that must be enforced
    const resolved = await resolveApproval(
      approvalId,
      "approved",
      "member@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_3" }
    );
    // M2b: Should be rejected - not owner or designated admin
    expect(resolved).toBeNull();

    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(approval?.status).toBe("pending");
  });

  test("M2b: fulfill enforces authority check for auth-link tickets (AUTHORITY OFF)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m2b_fulfill" })
    );
    expect(result.httpStatus).toBe(402);
    const approvalId = result.body.approvalId as string;

    // Approve with owner
    const resolved = await resolveApproval(
      approvalId,
      "approved",
      "owner@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_1" }
    );
    expect(resolved?.status).toBe("approved");

    // M2b: The approval should have approverMemberId set for fulfill verification
    expect(resolved?.approverMemberId).toBe("mem_1");
    expect(resolved?.requiredApproverKind).toBe("owner_or_designated_admin");

    // The fulfill path (assertApproverAuthorityForExecution) should not throw
    // because the approverMemberId is properly recorded
    const { assertApproverAuthorityForExecution } = await import("@/lib/approver-authority/verify");
    await expect(assertApproverAuthorityForExecution(resolved!)).resolves.toBeUndefined();
  });
});

// ============================================================================
// M3: fulfill-time recipient re-verification + snapshot hygiene
// M3: auth-link policy is re-evaluated at fulfill and approvalId re-invoke
// Conditions: "ForOrg", "internal 1 recipient", "no CC/BCC", "external prohibited"
// ============================================================================
describe("M3: fulfill時の宛先再判定とsnapshotの値保存禁止", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("approval snapshot does NOT contain oobCode or apiKey values", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m3_snapshot" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    
    const snapshotJson = JSON.stringify(approval!.metadata.snapshot ?? {});
    expect(snapshotJson).not.toContain("oobCodeForTesting123");
    expect(snapshotJson).not.toContain(DUMMY_API_KEY);
  });

  test("approval invokeSeed does NOT contain oobCode or apiKey values", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m3_seed" })
    );
    expect(result.httpStatus).toBe(402);
    const approval = await getApprovalById(result.body.approvalId as string, DEMO_ORG.id);
    expect(approval).toBeTruthy();
    
    const seedJson = JSON.stringify(approval!.metadata.invokeSeed ?? {});
    expect(seedJson).not.toContain("oobCodeForTesting123");
    expect(seedJson).not.toContain(DUMMY_API_KEY);
  });
});

import { fulfillApprovedInvoke, parseFulfillment } from "@/lib/approvals/fulfill";

describe("M3: fulfill時にauth-linkポリシーを再判定", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("M3: fulfill re-checks auth-link policy - blocks if recipient became external", async () => {
    // Create and approve within policy context, then clear rule before fulfill
    let approvedApproval: Awaited<ReturnType<typeof resolveApproval>> = null;
    
    await withNeedsApprovalMailPolicy(async () => {
      const result = await sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "m3_fulfill_ext" });
      expect(result.httpStatus).toBe(402);
      const approvalId = result.body.approvalId as string;

      // Approve the request within policy context
      approvedApproval = await resolveApproval(
        approvalId,
        "approved",
        "owner@tokyo307inc.com",
        DEMO_ORG.id,
        { memberId: "mem_1" }
      );
      expect(approvedApproval?.status).toBe("approved");
    });
    
    // After withNeedsApprovalMailPolicy returns, internal audience rule is cleared
    // M3: Fulfill should re-check auth-link policy and block
    // because the recipient is now considered external
    const fulfillResult = await fulfillApprovedInvoke(approvedApproval!);
    expect(fulfillResult?.ok).toBe(false);
    expect(fulfillResult?.error).toBe("fulfill_blocked_auth_link_policy");
  });

  test("Mask: auth-link auto-fulfill is blocked (requires re-invoke with approvalId)", async () => {
    // M3/Mask: Auth link approvals cannot be auto-fulfilled because the snapshot
    // body contains [REDACTED] in place of oobCode/apiKey (security requirement).
    await withNeedsApprovalMailPolicy(async () => {
      const result = await sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "mask_rerun" });
      expect(result.httpStatus).toBe(402);
      const approvalId = result.body.approvalId as string;

      // Approve the request
      const approved = await resolveApproval(
        approvalId,
        "approved",
        "owner@tokyo307inc.com",
        DEMO_ORG.id,
        { memberId: "mem_1" }
      );
      expect(approved?.status).toBe("approved");

      // Mask: Auto-fulfill should fail because snapshot body is masked
      const fulfillResult = await fulfillApprovedInvoke(approved!);
      expect(fulfillResult?.ok).toBe(false);
      expect(fulfillResult?.error).toBe("auth_link_rerun_required");
    });
  });
});

// ============================================================================
// L: 402 code should be "needs_approval" (not custom code)
// ============================================================================
describe("L: 402のcodeはneeds_approvalに統一", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("402 response code is 'needs_approval' not 'auth_action_link_needs_approval'", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "l_code" })
    );
    expect(result.httpStatus).toBe(402);
    expect(result.body.code).toBe("needs_approval");
    expect(result.body.code).not.toBe("auth_action_link_needs_approval");
  });

  test("auth_action_link reason is in a separate field", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      sendMailWithAuthLink({ to: "user@tokyo307inc.com", jobSuffix: "l_reason_field" })
    );
    expect(result.httpStatus).toBe(402);
    expect(result.body).toHaveProperty("authActionLinkReason");
  });
});

// ============================================================================
// L: Malformed CC/BCC rejection at submission time
// ============================================================================
describe("L: CC/BCC不正形式の申請拒否", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("malformed CC is rejected at submission (not at fulfill)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_malformed_cc_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
            cc: "not-an-email",
          },
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("has_cc_or_bcc");
  });

  test("malformed BCC is rejected at submission (not at fulfill)", async () => {
    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_malformed_bcc_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
            bcc: ";;;invalid;;;",
          },
        },
      })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("auth_action_link_blocked");
    expect(result.body.reason).toBe("has_cc_or_bcc");
  });
});

// ============================================================================
// L: createApproval failure should return error (not needs_approval)
// ============================================================================
import { setDemoCreateApprovalErrorForTests } from "@/lib/data/demo-approvals-store";

describe("L: createApproval失敗時は失敗を返す", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  afterEach(async () => {
    // Clear the error injection
    setDemoCreateApprovalErrorForTests(null);
    resetDemoMailPolicy();
    clearDemoRule();
  });

  test("L: createApproval failure returns 500 error (not 402 needs_approval)", async () => {
    // Inject an error into createApproval
    setDemoCreateApprovalErrorForTests(new Error("db_connection_failed"));

    const result = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId: `job_create_fail_${Date.now()}`,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: makeAuthLinkBody("user@tokyo307inc.com"),
          },
        },
      })
    );

    // L: Should return 500 error, not 402 needs_approval
    expect(result.httpStatus).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("approval_create_failed");
    expect(result.body.needs_approval).not.toBe(true);
  });
});

// ============================================================================
// H1: approvalId re-invoke actually sends mail with atomic claim
// ============================================================================
describe("H1: approvalId再実行で実際に送信し、atomic claimで1回のみ", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  afterEach(async () => {
    resetDemoMailPolicy();
    clearDemoRule();
  });

  test("H1: re-invoke with approvalId and original body marks approval as consumed (sent:true)", async () => {
    const jobId = `job_h1_send_${Date.now()}`;
    const originalBody = makeAuthLinkBody("user@tokyo307inc.com");

    // Create and approve the auth-link request
    const createResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    expect(createResult.httpStatus).toBe(402);
    const approvalId = createResult.body.approvalId as string;

    // Approve the request
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "owner@tokyo307inc.com",
      DEMO_ORG.id,
      { memberId: "mem_1" }
    );
    expect(approved?.status).toBe("approved");

    // Re-invoke with approvalId and original body
    const sendResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          approvalId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    // H1: Should return success and mark as sent
    expect(sendResult.httpStatus).toBe(200);
    expect(sendResult.body.ok).toBe(true);
    expect(sendResult.body.result?.sent).toBe(true);

    // Verify approval is now consumed (check metadata has fulfillment)
    const consumedApproval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(consumedApproval?.metadata?.authLinkFulfillment?.consumed).toBe(true);
  });

  test("H1: second re-invoke with same approvalId is rejected (already consumed)", async () => {
    const jobId = `job_h1_double_${Date.now()}`;
    const originalBody = makeAuthLinkBody("user@tokyo307inc.com");

    // Create, approve, and first send
    const createResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    const approvalId = createResult.body.approvalId as string;

    await resolveApproval(approvalId, "approved", "owner@tokyo307inc.com", DEMO_ORG.id, { memberId: "mem_1" });

    // First re-invoke succeeds
    const firstSend = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          approvalId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    expect(firstSend.httpStatus).toBe(200);

    // Second re-invoke should be rejected
    const secondSend = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          approvalId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    // H1: Second attempt should fail with "already consumed"
    expect(secondSend.httpStatus).toBe(409);
    expect(secondSend.body.ok).toBe(false);
    expect(secondSend.body.code).toBe("auth_link_already_sent");
  });
});

// ============================================================================
// H2: re-invoke must re-evaluate all 4 auth-link policy conditions
// ============================================================================
describe("H2: 再実行時にauth-linkポリシーの全4条件を再判定", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  afterEach(async () => {
    resetDemoMailPolicy();
    clearDemoRule();
  });

  test("H2: re-invoke with empty body fields is rejected (original required)", async () => {
    const jobId = `job_h2_empty_${Date.now()}`;
    const originalBody = makeAuthLinkBody("user@tokyo307inc.com");

    // Create and approve
    const createResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    const approvalId = createResult.body.approvalId as string;
    await resolveApproval(approvalId, "approved", "owner@tokyo307inc.com", DEMO_ORG.id, { memberId: "mem_1" });

    // Re-invoke with empty body (trying to bypass auth-link check)
    const emptyBodyResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          approvalId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: "", // Empty body - should be rejected
          },
        },
      })
    );
    // H2: Should reject because original body is required for auth-link sends
    expect(emptyBodyResult.httpStatus).toBe(409);
    expect(emptyBodyResult.body.ok).toBe(false);
    expect(emptyBodyResult.body.code).toBe("auth_link_original_required");
  });

  test("H2: re-invoke re-checks ForOrg condition", async () => {
    const jobId = `job_h2_org_${Date.now()}`;
    const originalBody = makeAuthLinkBody("user@tokyo307inc.com");
    // Use a proper UUID that matches DEMO_ORG's id format for testing
    // Note: SECRET_AUTH_ACTION_LINK_ORG_IDS only accepts UUID format
    // When the list is empty (no valid UUIDs), all orgs are enabled
    // So we need to use UUIDs that get filtered OUT to test the restriction
    const VALID_UUID_FOR_DEMO = "00000000-0000-0000-0000-000000000000";
    const OTHER_UUID = "11111111-1111-1111-1111-111111111111";

    // Create with empty _ORG_IDS (all orgs enabled - DEMO_ORG.id isn't a UUID so it's filtered out)
    // This allows the auth-link approval to be created for the demo org
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
    const createResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    const approvalId = createResult.body.approvalId as string;
    await resolveApproval(approvalId, "approved", "owner@tokyo307inc.com", DEMO_ORG.id, { memberId: "mem_1" });

    // Now restrict to OTHER_UUID only - DEMO_ORG is excluded
    process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = OTHER_UUID;

    const rerunResult = await withNeedsApprovalMailPolicy(() =>
      runGatewayInvoke({
        employeeId: "emp_sales",
        credentialId: "cred_sales",
        body: {
          tool: "mail.send",
          purpose: "sales.outreach",
          speakerId: AUTH_LINK_SPEAKER,
          jobId,
          approvalId,
          args: {
            to: "user@tokyo307inc.com",
            from: "noreply@oneplace.tokyo307inc.com",
            subject: "パスワード再設定",
            body: originalBody,
          },
        },
      })
    );
    // H2: Should be blocked because org is no longer in _ORG_IDS
    // The secret detection runs before priorApproval check and blocks google_api_key
    expect(rerunResult.httpStatus).toBe(400);
    expect(rerunResult.body.code).toBe("secret_detected_in_payload");
    expect(rerunResult.body.pattern).toBe("google_api_key");
  });
});
