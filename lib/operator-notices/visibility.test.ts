import { describe, expect, test } from "bun:test";
import { newNoticeId } from "./ids";
import type { OperatorNotice, OperatorNoticeReceipt, OperatorNoticeTarget } from "./types";
import {
  canAdvanceReceiptState,
  isNoticeCurrentlyVisible,
  isNoticeUnread,
  isPendingApply,
  noticeAudienceMatches,
} from "./visibility";

const ORG_A = "org_a";
const ORG_B = "org_b";
const EMP_A = "emp_a";
const EMP_B = "emp_b";
const OLD_ORG = "2020-01-01T00:00:00.000Z";
const NEW_ORG = "2026-10-01T00:00:00.000Z";
const PUBLISHED = "2026-06-01T00:00:00.000Z";

function notice(patch: Partial<OperatorNotice> & Pick<OperatorNotice, "audienceScope">): OperatorNotice {
  const id = patch.id ?? newNoticeId();
  return {
    id,
    seq: 1,
    version: 1,
    status: "published",
    severity: "normal",
    title: "t",
    changeSummary: "c",
    aiUsageChange: "u",
    effectiveAt: PUBLISHED,
    expiresAt: null,
    sticky: false,
    relatedFlags: [],
    applyMode: "self_rules",
    showToTenantAdmin: true,
    relatesToItemIds: [],
    bodyHash: "a".repeat(64),
    createdByUserId: null,
    createdByEmail: null,
    publishedByUserId: null,
    publishedByEmail: null,
    createdAt: PUBLISHED,
    publishedAt: PUBLISHED,
    withdrawnAt: null,
    updatedAt: PUBLISHED,
    ...patch,
  };
}

describe("visibility: all / orgs / employees", () => {
  test("audience_scope=all is visible to every org that existed at publish (sticky=false)", () => {
    const n = notice({ audienceScope: "all", sticky: false });
    expect(isNoticeCurrentlyVisible(n, [], { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: OLD_ORG })).toBe(true);
    expect(isNoticeCurrentlyVisible(n, [], { orgId: ORG_B, employeeId: EMP_B, orgCreatedAt: OLD_ORG })).toBe(true);
  });

  test("audience_scope=all sticky=false is hidden from orgs created after published_at", () => {
    const n = notice({ audienceScope: "all", sticky: false });
    expect(isNoticeCurrentlyVisible(n, [], { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: NEW_ORG })).toBe(false);
  });

  test("sticky all-audience notices are visible to orgs created later", () => {
    const n = notice({ audienceScope: "all", sticky: true });
    expect(isNoticeCurrentlyVisible(n, [], { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: NEW_ORG })).toBe(true);
  });

  test("orgs-scoped notice is visible only to targeted org (every employee)", () => {
    const n = notice({ audienceScope: "orgs" });
    const targets: OperatorNoticeTarget[] = [{ noticeId: n.id, orgId: ORG_A, employeeId: null }];
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: OLD_ORG })).toBe(true);
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_A, employeeId: "emp_a2", orgCreatedAt: OLD_ORG })).toBe(true);
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_B, employeeId: EMP_B, orgCreatedAt: OLD_ORG })).toBe(false);
  });

  test("employee-scoped notice is visible only to that employee in that org", () => {
    const n = notice({ audienceScope: "employees" });
    const targets: OperatorNoticeTarget[] = [{ noticeId: n.id, orgId: ORG_A, employeeId: EMP_A }];
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: OLD_ORG })).toBe(true);
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_A, employeeId: "emp_other", orgCreatedAt: OLD_ORG })).toBe(false);
    expect(isNoticeCurrentlyVisible(n, targets, { orgId: ORG_B, employeeId: EMP_A, orgCreatedAt: OLD_ORG })).toBe(false);
  });

  test("draft / withdrawn / expired are not currently visible", () => {
    const targets: OperatorNoticeTarget[] = [];
    const ctx = { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: OLD_ORG, now: new Date("2026-10-15T00:00:00.000Z") };
    expect(isNoticeCurrentlyVisible(notice({ audienceScope: "all", status: "draft" }), targets, ctx)).toBe(false);
    expect(isNoticeCurrentlyVisible(notice({ audienceScope: "all", status: "withdrawn" }), targets, ctx)).toBe(false);
    expect(
      isNoticeCurrentlyVisible(notice({ audienceScope: "all", expiresAt: "2026-10-01T00:00:00.000Z" }), targets, ctx)
    ).toBe(false);
  });

  test("withdrawn notice still audience-matches so receipts can be updated", () => {
    const n = notice({ audienceScope: "all", status: "withdrawn", sticky: true });
    expect(noticeAudienceMatches(n, [], { orgId: ORG_A, employeeId: EMP_A, orgCreatedAt: OLD_ORG })).toBe(true);
  });
});

describe("unread / pendingApply / ack state machine", () => {
  const n = notice({ audienceScope: "all", version: 2 });
  const delivered: OperatorNoticeReceipt = {
    noticeId: n.id,
    orgId: ORG_A,
    employeeId: EMP_A,
    firstListedAt: PUBLISHED,
    readAt: null,
    readVersion: null,
    state: "delivered",
    ackedVersion: null,
    ackedAt: null,
    applyEvidence: null,
    configChangeApprovalId: null,
    note: null,
    wakeState: "none",
    updatedAt: PUBLISHED,
  };

  test("no receipt or delivered → unread; correction with acked_version < version → unread; minor does not", () => {
    expect(isNoticeUnread(n, null, { kind: "initial" })).toBe(true);
    expect(isNoticeUnread(n, delivered, { kind: "initial" })).toBe(true);
    const read: OperatorNoticeReceipt = { ...delivered, state: "read", ackedVersion: 1 };
    expect(isNoticeUnread(n, read, { kind: "correction" })).toBe(true);
    expect(isNoticeUnread(n, read, { kind: "minor" })).toBe(false);
  });

  test("pendingApply follows apply_mode and non-terminal states", () => {
    expect(isPendingApply({ applyMode: "none" }, null)).toBe(false);
    expect(isPendingApply({ applyMode: "self_rules" }, null)).toBe(true);
    expect(isPendingApply({ applyMode: "self_rules" }, { ...delivered, state: "applied" })).toBe(false);
    expect(isPendingApply({ applyMode: "instructions_via_approval" }, { ...delivered, state: "needs_tenant_approval" })).toBe(
      true
    );
  });

  test("receipt state does not reverse from applied except on a newer version", () => {
    const applied: OperatorNoticeReceipt = { ...delivered, state: "applied", ackedVersion: 1 };
    expect(canAdvanceReceiptState(applied, "read", 1)).toBe(false);
    expect(canAdvanceReceiptState(applied, "applied", 1)).toBe(true);
    expect(canAdvanceReceiptState(applied, "read", 2)).toBe(true);
    expect(canAdvanceReceiptState(delivered, "read", 1)).toBe(true);
    expect(canAdvanceReceiptState({ ...delivered, state: "read", ackedVersion: 1 }, "applied", 1)).toBe(true);
  });
});
