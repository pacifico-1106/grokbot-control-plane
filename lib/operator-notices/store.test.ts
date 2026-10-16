/**
 * PR-A: demo store isolation. Org A notices never list / ack / receipt for org B.
 * Flag defaults OFF (no table access). Tests turn OPERATOR_NOTICES_ENABLED on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { isOperatorNoticesEnabled, isOperatorNoticesEnabledForOrg } from "@/lib/feature-flags";
import { noticeBodyHash } from "./hash";
import { isNoticeId, newFeedbackItemId, newNoticeId } from "./ids";
import {
  __forceInsertDemoReceipt,
  __registerDemoEmployee,
  __resetDemoOperatorNotices,
  __seedDemoNotice,
  __setDemoOrgCreatedAt,
  OperatorNoticeIsolationError,
  countVisibleNoticeStats,
  ensureDeliveredReceipt,
  listVisibleNotices,
} from "./store";

const FLAG = "OPERATOR_NOTICES_ENABLED";
const PILOT = "OPERATOR_NOTICES_PILOT_ORG_IDS";
const saved: Record<string, string | undefined> = {};

const ORG_A = "org_notices_a";
const ORG_B = "org_notices_b";
const EMP_A = "emp_notices_a";
const EMP_B = "emp_notices_b";

beforeEach(() => {
  saved[FLAG] = process.env[FLAG];
  saved[PILOT] = process.env[PILOT];
  process.env[FLAG] = "true";
  delete process.env[PILOT];
  __resetDemoOperatorNotices();
  __registerDemoEmployee(EMP_A, ORG_A);
  __registerDemoEmployee(EMP_B, ORG_B);
  __setDemoOrgCreatedAt(ORG_A, "2020-01-01T00:00:00.000Z");
  __setDemoOrgCreatedAt(ORG_B, "2020-01-01T00:00:00.000Z");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetDemoOperatorNotices();
});

describe("flags default OFF", () => {
  test("OPERATOR_NOTICES_ENABLED is off when unset; pilot empty means every org once on", () => {
    delete process.env[FLAG];
    expect(isOperatorNoticesEnabled()).toBe(false);
    expect(isOperatorNoticesEnabledForOrg(ORG_A)).toBe(false);
    process.env[FLAG] = "true";
    expect(isOperatorNoticesEnabledForOrg(ORG_A)).toBe(true);
    process.env[PILOT] = ORG_A;
    expect(isOperatorNoticesEnabledForOrg(ORG_A)).toBe(true);
    expect(isOperatorNoticesEnabledForOrg(ORG_B)).toBe(false);
    expect(isOperatorNoticesEnabledForOrg("")).toBe(false);
  });

  test("store does not list when the flag is OFF", async () => {
    delete process.env[FLAG];
    __seedDemoNotice({
      title: "hidden",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
    });
    const listed = await listVisibleNotices(ORG_A, EMP_A);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe("feature_disabled");
  });
});

describe("ids + body hash", () => {
  test("notice ids match ntc_ + 26-char Crockford ULID", () => {
    expect(isNoticeId(newNoticeId())).toBe(true);
    expect(isNoticeId("ntc_not-a-ulid")).toBe(false);
    expect(newFeedbackItemId().startsWith("fb_")).toBe(true);
  });

  test("body hash is sha256 of the three normalized fields", () => {
    const a = noticeBodyHash({ title: " t ", changeSummary: "c\r\n1", aiUsageChange: "u" });
    const b = noticeBodyHash({ title: "t", changeSummary: "c\n1", aiUsageChange: "u" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tenant isolation (demo store = same predicate as SQL)", () => {
  test("org-A-only notice is absent from org B list; ack path is not_found (no existence leak)", async () => {
    const n = __seedDemoNotice({
      title: "A only",
      changeSummary: "secret-to-a",
      aiUsageChange: "do-not-leak",
      audienceScope: "orgs",
      targets: [{ orgId: ORG_A, employeeId: null }],
    });
    const a = await listVisibleNotices(ORG_A, EMP_A);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.notices.map((x) => x.id)).toEqual([n.id]);

    const b = await listVisibleNotices(ORG_B, EMP_B);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.notices).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("secret-to-a");
    expect(JSON.stringify(b)).not.toContain(n.id);

    const byId = await listVisibleNotices(ORG_B, EMP_B, { noticeId: n.id });
    expect(byId.ok).toBe(true);
    if (!byId.ok) return;
    expect(byId.notices).toEqual([]);

    const ack = await ensureDeliveredReceipt(ORG_B, EMP_B, n.id);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe("not_found");
  });

  test("employee-scoped notice is hidden from another employee in the same org and from the other org", async () => {
    const otherA = "emp_notices_a2";
    __registerDemoEmployee(otherA, ORG_A);
    const n = __seedDemoNotice({
      title: "one employee",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "employees",
      targets: [{ orgId: ORG_A, employeeId: EMP_A }],
    });
    const forA = await listVisibleNotices(ORG_A, EMP_A);
    expect(forA.ok).toBe(true);
    if (forA.ok) expect(forA.notices.map((x) => x.id)).toEqual([n.id]);
    const sameOrg = await listVisibleNotices(ORG_A, otherA);
    expect(sameOrg.ok).toBe(true);
    if (sameOrg.ok) expect(sameOrg.notices).toEqual([]);
    const otherOrg = await listVisibleNotices(ORG_B, EMP_B);
    expect(otherOrg.ok).toBe(true);
    if (otherOrg.ok) expect(otherOrg.notices).toEqual([]);
  });

  test("whoami-style counts for org B stay 0 for an org-A notice (title never leaks into the count path)", async () => {
    __seedDemoNotice({
      title: "urgent-a",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "orgs",
      severity: "urgent",
      targets: [{ orgId: ORG_A, employeeId: null }],
    });
    const a = await countVisibleNoticeStats(ORG_A, EMP_A);
    const b = await countVisibleNoticeStats(ORG_B, EMP_B);
    expect(a).toEqual({ ok: true, unread: 1, urgentUnread: 1, pendingApply: 1 });
    expect(b).toEqual({ ok: true, unread: 0, urgentUnread: 0, pendingApply: 0 });
  });

  test("forced receipt insert for the wrong org is rejected by the demo trigger equivalent", () => {
    const n = __seedDemoNotice({
      title: "A only",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "orgs",
      targets: [{ orgId: ORG_A, employeeId: null }],
    });
    expect(() => __forceInsertDemoReceipt({ noticeId: n.id, orgId: ORG_B, employeeId: EMP_B })).toThrow(
      OperatorNoticeIsolationError
    );
    try {
      __forceInsertDemoReceipt({ noticeId: n.id, orgId: ORG_B, employeeId: EMP_B });
    } catch (err) {
      expect((err as OperatorNoticeIsolationError).code).toBe("operator_notice_receipt_not_visible");
    }
  });

  test("target employee in another org is rejected as operator_notice_cross_org", () => {
    expect(() =>
      __seedDemoNotice({
        title: "cross",
        changeSummary: "c",
        aiUsageChange: "u",
        audienceScope: "employees",
        targets: [{ orgId: ORG_A, employeeId: EMP_B }],
      })
    ).toThrow("operator_notice_cross_org");
  });

  test("all-audience + targets is rejected", () => {
    expect(() =>
      __seedDemoNotice({
        title: "all+targets",
        changeSummary: "c",
        aiUsageChange: "u",
        audienceScope: "all",
        targets: [{ orgId: ORG_A, employeeId: null }],
      })
    ).toThrow("operator_notice_all_has_no_targets");
  });

  test("listing creates a delivered receipt only for the visible org", async () => {
    const n = __seedDemoNotice({
      title: "hello",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
    });
    const first = await ensureDeliveredReceipt(ORG_A, EMP_A, n.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.receipt.state).toBe("delivered");
    expect(first.receipt.orgId).toBe(ORG_A);
    const again = await ensureDeliveredReceipt(ORG_A, EMP_A, n.id);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.receipt.firstListedAt).toBe(first.receipt.firstListedAt);
  });

  test("new tenant does not see a non-sticky all-audience notice published before it existed", async () => {
    __setDemoOrgCreatedAt(ORG_B, "2026-10-01T00:00:00.000Z");
    __seedDemoNotice({
      title: "old all",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: false,
      publishedAt: "2026-06-01T00:00:00.000Z",
    });
    const a = await listVisibleNotices(ORG_A, EMP_A);
    const b = await listVisibleNotices(ORG_B, EMP_B);
    expect(a.ok && a.ok ? a.notices.length : 0).toBe(1);
    expect(b.ok && b.ok ? b.notices.length : 0).toBe(0);
  });

  test("demo employees of DEMO_ORG still work after reset", async () => {
    __resetDemoOperatorNotices();
    process.env[FLAG] = "true";
    const n = __seedDemoNotice({
      title: "demo",
      changeSummary: "c",
      aiUsageChange: "u",
      audienceScope: "all",
      sticky: true,
    });
    const listed = await listVisibleNotices(DEMO_ORG.id, "emp_sales");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.notices.map((x) => x.id)).toContain(n.id);
  });
});
