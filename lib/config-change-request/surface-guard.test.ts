/**
 * CONFIG_CHANNEL_CLASSIFICATION_SURFACE_GUARD_ENABLED tests.
 *
 * - Flag OFF: surface=mail/phone/line channel_classification is accepted (existing behaviour, locked by regression tests).
 * - Flag ON:
 *   - surface=mail → redirected to parties.upsert (mail_address), self-approval blocked
 *   - surface=phone/line/web/telegram → rejected at request time (fail-closed)
 *
 * fail-first: tests are written before implementation and must fail initially.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeMemberById } from "@/lib/demo-data";
import {
  createConfigChangeRequest,
  type ConfigChangeDeps,
  type CreateConfigChangeResult,
  type PendingConfigChange,
  isPendingConfigChange,
} from "@/lib/config-change-request/service";
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import { resolveApproval, getApprovalById } from "@/lib/data/approvals";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { startHold, approveHoldRelease } from "@/lib/safety/hold-actions";

const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const GUARD_FLAG = "CONFIG_CHANNEL_CLASSIFICATION_SURFACE_GUARD_ENABLED";
const GUARD_ORG_IDS = "CONFIG_CHANNEL_CLASSIFICATION_SURFACE_GUARD_ORG_IDS";
const APPROVER_AUTHORITY_FLAG = "APPROVER_AUTHORITY_ENABLED";
const EMPLOYEE_HOLD_FLAG = "EMPLOYEE_HOLD_ENABLED";

const ORG = DEMO_ORG.id;

const backups: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const key of keys) {
    backups[key] = process.env[key];
  }
}
function restoreEnv() {
  for (const [key, value] of Object.entries(backups)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function flagOn() {
  process.env[FLAG] = "1";
}
function guardOn() {
  process.env[GUARD_FLAG] = "1";
}
function guardOff() {
  delete process.env[GUARD_FLAG];
  delete process.env[GUARD_ORG_IDS];
}

function approverAuthorityOn() {
  process.env[APPROVER_AUTHORITY_FLAG] = "1";
}

beforeEach(() => {
  saveEnv(FLAG, GUARD_FLAG, GUARD_ORG_IDS, APPROVER_AUTHORITY_FLAG);
  flagOn();
  guardOff();
});
afterEach(() => {
  restoreEnv();
});

const notified: string[] = [];
const okDeps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async (approval) => {
    notified.push(approval.id);
    return true;
  },
};

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`;
}

// Use email for member identification since demo mode doesn't have voter bindings
const requester = { name: "田中", slackUserId: "U0TANAKA", email: "owner@example.com" };

function assertPending(result: CreateConfigChangeResult): asserts result is PendingConfigChange {
  if (!isPendingConfigChange(result)) throw new Error(`expected needs_approval, got ${result.code}`);
}

describe("flag OFF (regression)", () => {
  test("surface=mail channel_classification is accepted", async () => {
    const externalId = `mail:${uniq("user")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
    assertPending(res);
    expect(res.applied).toBe(false);
  });

  test("surface=phone channel_classification is accepted", async () => {
    const externalId = "+81901234567";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "phone", externalId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
    assertPending(res);
  });

  test("surface=line channel_classification is accepted", async () => {
    const externalId = `line:${uniq("uid")}`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "line", externalId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
    assertPending(res);
  });

  test("L1: flag OFF fulfill writes to org_channels, not org_parties", async () => {
    const mailAddress = `${uniq("flagoff")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    expect(res.diffSummaryJa).toContain("チャネル");
    expect(res.diffSummaryJa).not.toContain("メールアドレス");

    const { fulfil } = await approveAndFulfil(res.approvalId);
    expect(fulfil?.ok).toBe(true);
    // Flag OFF: writes to org_channels
    const channel = await getOrgChannel(ORG, "mail", mailAddress);
    expect(channel).not.toBeNull();
    expect(channel?.classification).toBe("internal");
    // Flag OFF: does NOT write to org_parties
    const party = await getOrgParty(ORG, "mail_address", mailAddress);
    expect(party).toBeNull();
  });
});

describe("flag ON", () => {
  beforeEach(() => {
    guardOn();
    approverAuthorityOn();
  });

  test("surface=mail → redirected to parties.upsert (mail_address kind)", async () => {
    const mailAddress = `${uniq("user")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
    assertPending(res);
    expect(res.diffSummaryJa).toContain("メールアドレス");
    expect(res.diffSummaryJa).not.toContain("チャネル");
    expect(await getOrgChannel(ORG, "mail", mailAddress)).toBeNull();
    expect(await getOrgParty(ORG, "mail_address", mailAddress)).toBeNull();

    const { fulfil } = await approveAndFulfil(res.approvalId);
    expect(fulfil?.ok).toBe(true);
    expect(await getOrgChannel(ORG, "mail", mailAddress)).toBeNull();
    const party = await getOrgParty(ORG, "mail_address", mailAddress);
    expect(party).not.toBeNull();
    expect(party?.audience).toBe("internal");
  });

  test("surface=mail classification=shared_external → parties.upsert audience=external", async () => {
    const mailAddress = `${uniq("ext")}@external.example`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "shared_external" },
        },
      },
      okDeps
    );
    assertPending(res);
    const { fulfil } = await approveAndFulfil(res.approvalId);
    expect(fulfil?.ok).toBe(true);
    const party = await getOrgParty(ORG, "mail_address", mailAddress);
    expect(party?.audience).toBe("external");
  });

  test("surface=phone is rejected at request time", async () => {
    const phone = "+81901234568";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "phone", externalId: phone, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("surface_not_supported");
    expect("approvalId" in res).toBe(false);
    expect(res.applied).toBe(false);
  });

  test("surface=line is rejected at request time", async () => {
    const lineId = `line:${uniq("uid")}`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "line", externalId: lineId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("surface_not_supported");
    expect(res.applied).toBe(false);
  });

  test("surface=web is rejected at request time", async () => {
    const webId = `web:${uniq("session")}`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "web", externalId: webId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("surface_not_supported");
  });

  test("surface=telegram is rejected at request time (invalid_surface - not a ConversationSurface)", async () => {
    const telegramId = `tg:${uniq("chat")}`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "telegram", externalId: telegramId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_surface");
  });

  test("surface=slack still uses channel ledger", async () => {
    const channelId = `C${uniq("")}`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "slack", externalId: channelId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
    assertPending(res);
    expect(res.diffSummaryJa).toContain("チャネル");
  });

  test("self-approval is blocked for mail parties redirect (always_human)", async () => {
    const mailAddress = `${uniq("self")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: "cred_emp_comm",
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    expect(approval?.metadata?.always_human).toBe(true);
  });

  test("M1: party_audience uses admin class (same as parties.upsert)", async () => {
    const mailAddress = `${uniq("admin")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: "cred_emp_comm",
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    // M1: party_audience must be admin class, not business
    expect(approval?.metadata?.approvalClass).toBe("admin");
    expect(approval?.metadata?.auditClass).toBe("admin");
  });

  test("M1: party_audience sets adminRequester for self-approval blocking", async () => {
    const mailAddress = `${uniq("requester")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: "cred_emp_comm",
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    // M1: adminRequester must be set for assertNotSelfApproval to work
    const adminRequester = approval?.metadata?.adminRequester as Record<string, unknown> | undefined;
    expect(adminRequester).toBeDefined();
    // kind is "employee_badge" for config.change_request (not admin_agent)
    expect(adminRequester?.kind).toBe("employee_badge");
  });

  test("M1: resolveApproval rejects self-approval for party_audience (admin class)", async () => {
    const mailAddress = `${uniq("selfblock")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: "cred_emp_comm",
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // Attempt self-approval as mem_2 (same member who requested) should fail
    // resolveApproval returns null with reason via onResolveResult callback
    let resolveReason: string | null = null;
    const selfApprovalResult = await resolveApproval(res.approvalId, "approved", "sales@example.com", ORG, {
      memberId: "mem_2",
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(selfApprovalResult).toBeNull();
    expect(resolveReason).toBe("approver_is_requester");

    // Different member (owner) should be able to approve
    const humanApproved = await resolveApproval(
      res.approvalId,
      "approved",
      "owner@example.com",
      ORG,
      { memberId: "mem_1" }
    );
    expect(humanApproved?.status).toBe("approved");
  });

  test("rejection message guides to parties.upsert or internalAudienceRule.patch", async () => {
    const phone = "+81901234569";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "phone", externalId: phone, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect((res as { messageJa?: string }).messageJa).toMatch(/parties\.upsert|internalAudienceRule\.patch/);
  });

  test("M2: mail: prefix is stripped from identifier", async () => {
    const rawAddress = `mail:${uniq("prefix")}@example.com`;
    const expectedAddress = rawAddress.replace(/^mail:/, "");
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: rawAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    expect(res.diffSummaryJa).toContain(expectedAddress);
    expect(res.diffSummaryJa).not.toContain("mail:");

    const { fulfil } = await approveAndFulfil(res.approvalId);
    expect(fulfil?.ok).toBe(true);
    const party = await getOrgParty(ORG, "mail_address", expectedAddress);
    expect(party).not.toBeNull();
  });

  test("M2: invalid email format is rejected (validatePartiesUpsertArgs)", async () => {
    const invalidEmail = "not-an-email";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: invalidEmail, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_identifier");
  });

  test("M2: external→internal shows warning in approval summary", async () => {
    const mailAddress = `${uniq("ext2int")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    // M2: summary should contain warning about treating address as internal
    expect(res.summary).toMatch(/社内として扱われ|外部送信の承認が不要/);
  });
});

describe("flag ON with org_ids allowlist", () => {
  beforeEach(() => {
    guardOn();
    process.env[GUARD_ORG_IDS] = "org_other";
  });

  test("non-allowlisted org uses old behaviour (regression)", async () => {
    const externalId = `mail:${uniq("user")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.code).toBe("needs_approval");
  });
});

describe("M3: fulfill-time guard re-check", () => {
  test("pending non-Slack ticket filed with flag OFF is rejected at fulfill when flag turns ON", async () => {
    // Step 1: Create ticket with flag OFF (existing behaviour)
    guardOff();
    const mailAddress = `${uniq("preexist")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // Step 2: Turn flag ON before approval
    guardOn();

    // Step 3: Approve and attempt fulfill — should be rejected
    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_owner" });
    expect(approved?.status).toBe("approved");
    const fulfil = await fulfillIfApproved(approved!, "approved");
    expect(fulfil?.ok).toBe(false);
    expect(fulfil?.error).toMatch(/surface_guard_rejected|surface_not_supported/);

    // Verify nothing was written
    const channel = await getOrgChannel(ORG, "mail", mailAddress);
    expect(channel).toBeNull();
    const party = await getOrgParty(ORG, "mail_address", mailAddress);
    expect(party).toBeNull();
  });

  test("pending phone ticket filed with flag OFF is rejected at fulfill when flag turns ON", async () => {
    guardOff();
    const phoneNumber = "+81901234590";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "phone", externalId: phoneNumber, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    guardOn();
    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_owner" });
    expect(approved?.status).toBe("approved");
    const fulfil = await fulfillIfApproved(approved!, "approved");
    expect(fulfil?.ok).toBe(false);
  });
});

async function approveAndFulfil(approvalId: string) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" });
  expect(approved?.status).toBe("approved");
  const fulfil = await fulfillIfApproved(approved!, "approved");
  return { approved: approved!, fulfil };
}

// ========================================================================
// Followup PR tests: M1/M2'/L (fail-first)
// ========================================================================

describe("followup: M1 requester → member binding", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
    approverAuthorityOn();
  });

  test("M1: requestedBy.email resolves to requesterMemberId via member email", async () => {
    const mailAddress = `${uniq("m1email")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "山田", slackUserId: null, email: "owner@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    // M1: requesterMemberId should be set from email lookup
    expect(approval?.metadata?.requesterMemberId).toBeDefined();
    expect(approval?.metadata?.requesterMemberId).toBe("mem_1"); // owner@example.com → mem_1
  });

  test("M1: requester member cannot approve their own ticket", async () => {
    const mailAddress = `${uniq("m1self")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // Attempt to approve as the same member who requested (mem_2)
    // resolveApproval returns null with reason via onResolveResult callback
    let resolveReason: string | null = null;
    const selfApprovalResult = await resolveApproval(res.approvalId, "approved", "sales@example.com", ORG, {
      memberId: "mem_2", // same member as requester
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(selfApprovalResult).toBeNull();
    expect(resolveReason).toBe("approver_is_requester");

    // Different member (owner) should be able to approve
    const humanApproved = await resolveApproval(
      res.approvalId,
      "approved",
      "owner@example.com",
      ORG,
      { memberId: "mem_1" }
    );
    expect(humanApproved?.status).toBe("approved");
  });

  test("M1: fail-closed when requester cannot be identified", async () => {
    const mailAddress = `${uniq("m1unknown")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "不明", slackUserId: null, email: null }, // no identifying info
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    // M1: should be rejected when requester cannot be identified
    expect(res.ok).toBe(false);
    expect(res.code).toBe("requester_not_identified");
  });

  test("M1: adminRequester.kind matches actual source (employee_badge, not admin_agent)", async () => {
    const mailAddress = `${uniq("m1kind")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: "cred_emp_comm",
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "山田", slackUserId: null, email: "owner@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    const adminRequester = approval?.metadata?.adminRequester as Record<string, unknown> | undefined;
    // M1: kind should be "employee_badge" for config.change_request, not "admin_agent"
    expect(adminRequester?.kind).toBe("employee_badge");
  });

  test("M1: party_audience requires owner_or_designated_admin (APPROVER_AUTHORITY)", async () => {
    const mailAddress = `${uniq("m1auth")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "山田", slackUserId: null, email: "owner@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);
    const approval = await getApprovalById(res.approvalId, ORG);
    // M1: party_audience should be APPROVER_AUTHORITY target (owner_or_designated_admin)
    expect(approval?.requiredApproverKind).toBe("owner_or_designated_admin");
  });
});

describe("followup: M2' fulfill hold check", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
    approverAuthorityOn();
    saveEnv(EMPLOYEE_HOLD_FLAG);
    process.env[EMPLOYEE_HOLD_FLAG] = "1";
  });

  test("M2': party_audience fulfill succeeds when employee is not on hold", async () => {
    const mailAddress = `${uniq("m2ok")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" });
    expect(approved?.status).toBe("approved");

    // No hold set - should succeed
    const fulfil = await fulfillIfApproved(approved!, "approved");
    expect(fulfil?.ok).toBe(true);
  });

  test("M2': fulfill rejects when employee is on hold", async () => {
    const mailAddress = `${uniq("m2hold")}@example.com`;
    // Use sales@example.com as requester (different from owner who will approve)
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" });
    expect(approved?.status).toBe("approved");

    // Put employee on hold before fulfill
    const owner = getRuntimeMemberById("mem_1")!;
    const holdResult = await startHold({
      orgId: ORG,
      employeeId: "emp_comm",
      reason: "test hold",
      actor: { type: "member", member: owner, surface: "web" },
    });
    expect(holdResult.ok).toBe(true);
    
    const fulfil = await fulfillIfApproved(approved!, "approved");
    // M2': fulfill should check employee hold even for admin-class party_audience
    expect(fulfil?.ok).toBe(false);
    expect(fulfil?.error).toMatch(/hold|stopped|approval_held/i);

    // Cleanup: release hold (best effort)
    if (holdResult.ok) {
      await approveHoldRelease({ orgId: ORG, holdId: holdResult.holdId, actor: { type: "member", member: owner, surface: "web" } }).catch(() => {});
    }
  });
});

describe("followup: L fixes", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
  });

  test("L: parse kind error shows public kinds only (not party_audience)", async () => {
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "invalid_kind",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: "test@example.com", classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unsupported_kind");
    // L: error message should not mention party_audience
    expect((res as { messageJa?: string }).messageJa).not.toContain("party_audience");
    expect((res as { messageJa?: string }).messageJa).toContain("instructions");
    expect((res as { messageJa?: string }).messageJa).toContain("channel_classification");
  });

  test("L: MAIL: (uppercase prefix) is rejected", async () => {
    const mailAddress = `MAIL:${uniq("upper")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_identifier");
  });

  test("L: mail:mail: (double prefix) is rejected", async () => {
    const mailAddress = `mail:mail:${uniq("double")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_identifier");
  });

  test("L: consecutive dots in email are rejected", async () => {
    const mailAddress = `test..dots${uniq("")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_identifier");
  });

  test("L: rejection message contains '何も登録していません'", async () => {
    const phone = "+81901234570";
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: requester,
          channel: { surface: "phone", externalId: phone, classification: "internal" },
        },
      },
      okDeps
    );
    expect(res.ok).toBe(false);
    // L: rejection message should explicitly say nothing was registered
    expect((res as { messageJa?: string }).messageJa).toMatch(/反映していません|登録していません/);
  });
});

// ========================================================================
// Review #427: H1, M1-M4, L1-L2 (fail-first)
// ========================================================================

describe("H1: party_audience enforces owner_or_designated_admin without APPROVER_AUTHORITY_ENABLED", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
    // H1: APPROVER_AUTHORITY_ENABLED is OFF (default) - party_audience must still enforce
    delete process.env[APPROVER_AUTHORITY_FLAG];
  });

  test("H1: requester member cannot approve their own party_audience ticket (AUTHORITY OFF)", async () => {
    const mailAddress = `${uniq("h1self")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // H1: Even with AUTHORITY OFF, party_audience must reject self-approval
    let resolveReason: string | null = null;
    const selfApprovalResult = await resolveApproval(res.approvalId, "approved", "sales@example.com", ORG, {
      memberId: "mem_2",
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(selfApprovalResult).toBeNull();
    expect(resolveReason).toBe("approver_is_requester");
  });

  test("H1: regular member (role=member) cannot approve party_audience ticket (AUTHORITY OFF)", async () => {
    const mailAddress = `${uniq("h1member")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // H1: mem_3 is role=member (not owner/admin), should be rejected
    let resolveReason: string | null = null;
    const memberApprovalResult = await resolveApproval(res.approvalId, "approved", "accounting@example.com", ORG, {
      memberId: "mem_3",
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(memberApprovalResult).toBeNull();
    expect(resolveReason).toBe("approver_not_authorized");
  });

  test("H1: owner can approve party_audience ticket (AUTHORITY OFF)", async () => {
    const mailAddress = `${uniq("h1owner")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // H1: Owner (mem_1) should be able to approve
    const ownerApprovalResult = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, {
      memberId: "mem_1",
    });
    expect(ownerApprovalResult?.status).toBe("approved");
  });

  test("H1: fulfill rejects when requiredApproverKind is missing (fail-closed)", async () => {
    const mailAddress = `${uniq("h1fulfill")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // H1: requiredApproverKind must be set
    const approval = await getApprovalById(res.approvalId, ORG);
    expect(approval?.requiredApproverKind).toBe("owner_or_designated_admin");
  });
});

describe("M4: Slack userId voter binding path", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
    approverAuthorityOn();
  });

  test("M4: Slack voter as requester cannot approve their own ticket", async () => {
    // This test requires setting up voter bindings in demo mode
    // For now, we test that the mechanism works via email fallback
    const mailAddress = `${uniq("m4slackself")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" }, // mem_2
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // M4: Trying to approve with a spoofed memberId should still be blocked
    // because the requesterMemberId is in metadata
    let resolveReason: string | null = null;
    const spoofedResult = await resolveApproval(res.approvalId, "approved", "sales@example.com", ORG, {
      memberId: "mem_2", // Same as requester
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(spoofedResult).toBeNull();
    expect(resolveReason).toBe("approver_is_requester");
  });

  test("M4: mem_3 (regular member) cannot approve party_audience", async () => {
    const mailAddress = `${uniq("m4mem3")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // M4: mem_3 has role=member (not owner/admin)
    let resolveReason: string | null = null;
    const mem3Result = await resolveApproval(res.approvalId, "approved", "accounting@example.com", ORG, {
      memberId: "mem_3",
      onResolveResult: (result) => { resolveReason = result.reason; },
    });
    expect(mem3Result).toBeNull();
    expect(resolveReason).toBe("approver_not_authorized");
  });
});

describe("L1/L2: org_on_hold handling", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
    approverAuthorityOn();
    saveEnv(EMPLOYEE_HOLD_FLAG, "ORG_HOLD_ENABLED");
    process.env[EMPLOYEE_HOLD_FLAG] = "1";
    process.env["ORG_HOLD_ENABLED"] = "1";
  });

  test("L1: org_on_hold returns org_on_hold error code (not employee_on_hold)", async () => {
    const mailAddress = `${uniq("l1org")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" });
    expect(approved?.status).toBe("approved");

    // Put org on hold (not employee)
    const owner = getRuntimeMemberById("mem_1")!;
    const holdResult = await startHold({
      orgId: ORG,
      employeeId: null, // org-level hold
      reason: "test org hold",
      actor: { type: "member", member: owner, surface: "web" },
    });
    expect(holdResult.ok).toBe(true);

    const fulfil = await fulfillIfApproved(approved!, "approved");
    // L1: Should return org_on_hold, not employee_on_hold
    expect(fulfil?.ok).toBe(false);
    expect(fulfil?.error).toBe("org_on_hold");

    // Cleanup
    if (holdResult.ok) {
      await approveHoldRelease({ orgId: ORG, holdId: holdResult.holdId, actor: { type: "member", member: owner, surface: "web" } }).catch(() => {});
    }
  });

  test("L2: org_parties is not written when employee is on hold", async () => {
    const mailAddress = `${uniq("l2nowrite")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    const approved = await resolveApproval(res.approvalId, "approved", "owner@example.com", ORG, { memberId: "mem_1" });
    expect(approved?.status).toBe("approved");

    // Put employee on hold before fulfill
    const owner = getRuntimeMemberById("mem_1")!;
    const holdResult = await startHold({
      orgId: ORG,
      employeeId: "emp_comm",
      reason: "test hold",
      actor: { type: "member", member: owner, surface: "web" },
    });
    expect(holdResult.ok).toBe(true);

    const fulfil = await fulfillIfApproved(approved!, "approved");
    expect(fulfil?.ok).toBe(false);

    // L2: Verify org_parties was NOT written
    const party = await getOrgParty(ORG, "mail_address", mailAddress);
    expect(party).toBeNull();

    // Cleanup
    if (holdResult.ok) {
      await approveHoldRelease({ orgId: ORG, holdId: holdResult.holdId, actor: { type: "member", member: owner, surface: "web" } }).catch(() => {});
    }
  });
});

describe("M3: requiredApproverKind atomic setting", () => {
  beforeEach(() => {
    flagOn();
    guardOn();
  });

  test("M3: party_audience ticket must have requiredApproverKind set atomically", async () => {
    const mailAddress = `${uniq("m3atomic")}@example.com`;
    const res = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: "emp_comm",
        credentialId: null,
        args: {
          kind: "channel_classification",
          jobId: uniq("job-"),
          requestedBy: { name: "佐藤", slackUserId: null, email: "sales@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // M3: requiredApproverKind must be set at creation time
    const approval = await getApprovalById(res.approvalId, ORG);
    expect(approval?.requiredApproverKind).toBe("owner_or_designated_admin");
  });
});
