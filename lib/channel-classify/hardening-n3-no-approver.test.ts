/**
 * Follow-up to PR-B (N3): an org with no admin approver gets NO system-filed
 * ticket (nobody could resolve it). The approver policy is checked at creation
 * time regardless of ADMIN_APPROVER_POLICY_REQUIRED; ops gets an ids-only
 * notice (rate-limited per org); the tenant gets an audit row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval } from "@/lib/data/approvals";
import { listAuditEvents } from "@/lib/data/audit";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { handleChannelJoin } from "@/lib/channel-classify/join";
import { defaultHasAdminApprover, setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";

const ORG = DEMO_ORG.id;
const OPS_ORG = "00000000-0000-4000-8000-0000000000ff";
let created = 0;
let audits: Array<{ orgId: string; action: string; summary?: string; metadata?: Record<string, unknown> }> = [];
let mails: Array<{ to: string[]; subject: string; text: string }> = [];
let sent: string[] = [];
let n = 0;

function signal() {
  n += 1;
  return { orgId: ORG, surface: "line" as const, externalId: `Cnoappr${String(n).padStart(5, "0")}`, trigger: "line_join" as const };
}

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  process.env.PLATFORM_OPS_ORG_ID = OPS_ORG;
  process.env.APPROVAL_ALERT_OPS_EMAILS = "ops@example.com";
  delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
  created = 0;
  audits = [];
  mails = [];
  sent = [];
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => false,
    createApproval: async (input) => {
      created += 1;
      return createApproval(input);
    },
  });
  setStuckNotifyDepsForTests({
    listChannels: async () => [],
    send: async (_c, text) => { sent.push(text); return { ok: true }; },
    audit: async (event) => { audits.push(event); },
    mail: async (input) => { mails.push(input); return { ok: true }; },
  });
});

afterEach(() => {
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  delete process.env.PLATFORM_OPS_ORG_ID;
  delete process.env.APPROVAL_ALERT_OPS_EMAILS;
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
});

describe("N3 no approver → no system ticket", () => {
  test("flag ADMIN_APPROVER_POLICY_REQUIRED OFF still checks: state no_approver, no ticket, ops notified with ids only", async () => {
    const s = signal();
    const outcome = await handleChannelJoin(s);
    expect(outcome.state).toBe("no_approver");
    expect(created).toBe(0);
    const mirror = audits.find((a) => a.orgId === OPS_ORG);
    expect(mirror?.metadata).toMatchObject({ targetOrgId: ORG, surface: "line", externalId: s.externalId, reason: "no_admin_approver" });
    expect(mails.length).toBe(1);
    expect(mails[0].text).toContain(ORG);
    expect(mails[0].text).toContain(s.externalId);
    // ids only: no summary / facts / member data
    expect(mails[0].text.length).toBeLessThan(600);
    const tenantAudit = (await listAuditEvents(ORG)).filter((a) => a.action === "channel_classify.proposal_failed");
    expect(tenantAudit.some((a) => (a.metadata as Record<string, unknown> | undefined)?.reason === "no_admin_approver")).toBe(true);
  });

  test("ops notice is rate-limited per org (second channel → no second mail)", async () => {
    await handleChannelJoin(signal());
    await handleChannelJoin(signal());
    expect(mails.length).toBe(1);
    expect(created).toBe(0);
  });

  test("approver lookup error counts as no approver (fail-closed)", async () => {
    setProposalDepsForTests({ notifyApproval: async () => true, hasApprover: async () => { throw new Error("db down"); } });
    expect((await handleChannelJoin(signal())).state).toBe("no_approver");
  });

  test("no claim is left behind: once an approver exists the same channel is proposed", async () => {
    const s = signal();
    expect((await handleChannelJoin(s)).state).toBe("no_approver");
    setProposalDepsForTests({ notifyApproval: async () => true, hasApprover: async () => true });
    expect((await handleChannelJoin(s)).state).toBe("created");
  });

  test("default approver check uses the org's admin route or owners", async () => {
    expect(typeof (await defaultHasAdminApprover(ORG))).toBe("boolean");
    expect(await defaultHasAdminApprover("")).toBe(false);
  });
});
