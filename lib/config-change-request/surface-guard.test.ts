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
import { DEMO_ORG } from "@/lib/demo-data";
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

const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const GUARD_FLAG = "CONFIG_CHANNEL_CLASSIFICATION_SURFACE_GUARD_ENABLED";
const GUARD_ORG_IDS = "CONFIG_CHANNEL_CLASSIFICATION_SURFACE_GUARD_ORG_IDS";

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

beforeEach(() => {
  saveEnv(FLAG, GUARD_FLAG, GUARD_ORG_IDS);
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

const requester = { name: "田中", slackUserId: "U0TANAKA", email: null };

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
          requestedBy: { name: "自分", slackUserId: "U_SELF", email: "self@example.com" },
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
          requestedBy: { name: "田中", slackUserId: "U0TANAKA", email: "tanaka@example.com" },
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
          requestedBy: { name: "田中", slackUserId: "U0TANAKA", email: "tanaka@example.com" },
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
    expect(adminRequester?.kind).toBe("admin_agent");
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
          requestedBy: { name: "田中", slackUserId: "U0TANAKA", email: "tanaka@example.com" },
          channel: { surface: "mail", externalId: mailAddress, classification: "internal" },
        },
      },
      okDeps
    );
    assertPending(res);

    // Attempt self-approval with same credentialId/actorId should fail
    let selfApprovalDenied = false;
    try {
      await resolveApproval(res.approvalId, "approved", "cred_emp_comm", ORG, {
        actorId: "cred_emp_comm",
      });
    } catch (error) {
      selfApprovalDenied = error instanceof Error && error.message === "self_approval_denied";
    }
    expect(selfApprovalDenied).toBe(true);

    // Human approver should succeed
    const humanApproved = await resolveApproval(
      res.approvalId,
      "approved",
      "owner@example.com",
      ORG,
      { actorId: "mem_owner" }
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
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "user_owner" });
  expect(approved?.status).toBe("approved");
  const fulfil = await fulfillIfApproved(approved!, "approved");
  return { approved: approved!, fulfil };
}
