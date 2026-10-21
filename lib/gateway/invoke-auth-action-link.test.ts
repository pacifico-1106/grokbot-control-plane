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
import { getApprovalById, listApprovals } from "@/lib/data";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import type { Employee } from "@/lib/types";

// Internal domain for test
const INTERNAL_DOMAIN = "tokyo307inc.com";

// google_api_key pattern requires 39+ chars (AIza + 35)
const DUMMY_API_KEY = "AIzaSyDummyKeyForTestingPurposesABC12345";

let savedFlag: string | undefined;
let savedOrgIds: string | undefined;

beforeEach(() => {
  savedFlag = process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  savedOrgIds = process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
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
    expect(result.body.code).toBe("auth_action_link_needs_approval");
    
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
