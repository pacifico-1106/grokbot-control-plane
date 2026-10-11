/**
 * 運営からのお知らせ PR-A data layer (demo / in-memory; mirrors migration 20261013100000,
 * whose triggers and visibility SQL are covered by tests/security/db-operator-notices.sql).
 * Tenant isolation: org / employee come only from the caller's scope (= the 社員証), and an
 * org B scope never sees, counts or receipts org A's notice.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const s = await import("@/lib/operator-notices/store");
const { NOTICE_ID_RE } = await import("@/lib/operator-notices/ids");

const OA = "11111111-1111-4111-8111-11111111111a";
const OB = "11111111-1111-4111-8111-11111111111b";
const OC = "11111111-1111-4111-8111-11111111111c"; // created after the 'all' notice
const A1 = { orgId: OA, employeeId: "22222222-2222-4222-8222-2222222222a1" };
const A2 = { orgId: OA, employeeId: "22222222-2222-4222-8222-2222222222a2" };
const B1 = { orgId: OB, employeeId: "22222222-2222-4222-8222-2222222222b1" };
const C1 = { orgId: OC, employeeId: "22222222-2222-4222-8222-2222222222c1" };
const OP = { userId: "op-user-1", email: "ops@staffpass.example" };
const T0 = new Date("2026-10-12T00:00:00Z");

let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.OPERATOR_NOTICES_ENABLED;
  process.env.OPERATOR_NOTICES_ENABLED = "true";
  s.__resetDemoOperatorNoticesForTests({
    orgs: [{ id: OA, createdAt: "2026-01-01T00:00:00Z" }, { id: OB, createdAt: "2026-01-01T00:00:00Z" }, { id: OC, createdAt: "2026-10-13T00:00:00Z" }],
    employees: [A1, A2, B1, C1].map((x) => ({ id: x.employeeId, orgId: x.orgId })),
  });
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.OPERATOR_NOTICES_ENABLED; else process.env.OPERATOR_NOTICES_ENABLED = savedFlag;
});

const draft = (o: Partial<import("@/lib/operator-notices/store").DraftInput> = {}) =>
  s.createDraft({ title: "週次フィードバックの仕様変更", changeSummary: "変更点", aiUsageChange: "使い方", ...o }, OP);
async function published(o: Partial<import("@/lib/operator-notices/store").DraftInput> = {}, targets: Array<{ orgId: string; employeeId: string | null }> = []) {
  const n = await draft(o);
  if (targets.length) await s.setTargets(n.id, targets, OP);
  return s.publish(n.id, OP, { now: T0 });
}
const titles = async (scope: { orgId: string; employeeId: string }, now = T0) =>
  (await s.listVisible(scope, { now })).map((n) => n.title).sort();

describe("flag OFF: the data layer does nothing", () => {
  test("every operation refuses with operator_notices_disabled", async () => {
    delete process.env.OPERATOR_NOTICES_ENABLED;
    const calls: Array<() => Promise<unknown>> = [
      () => draft(), () => s.listVisible(A1), () => s.getVisible(A1, "ntc_01J0000000000000000000000A"),
      () => s.countForWhoami(A1), () => s.recordListed(A1, []), () => s.publish("ntc_01J0000000000000000000000A", OP),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ code: "operator_notices_disabled" });
  });
});

describe("drafts: secret detection and limits", () => {
  test("a draft gets an ntc_ ULID id, version 1, status draft, body hash", async () => {
    const n = await draft();
    expect(n.id).toMatch(NOTICE_ID_RE);
    expect(n).toMatchObject({ status: "draft", version: 1, ackRequiredVersion: 1, audienceScope: "all", applyMode: "self_rules", showToTenantAdmin: true, sticky: false });
    expect(n.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
  test("a secret in any body field blocks the save (no row stored), no operator exception", async () => {
    for (const field of ["title", "changeSummary", "aiUsageChange"] as const) {
      await expect(draft({ [field]: "社員証 gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab" })).rejects.toMatchObject({ code: "secret_detected" });
    }
    await expect(draft({ aiUsageChange: "AKIAIOSFODNN7EXAMPLE aws secret" })).rejects.toMatchObject({ code: "secret_detected" });
    expect(s.__demoNoticeCountForTests()).toBe(0);
  });
  test("a secret added by an edit or a correction is blocked too", async () => {
    const n = await draft();
    await expect(s.updateDraft(n.id, { changeSummary: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab" }, OP)).rejects.toMatchObject({ code: "secret_detected" });
    await s.publish(n.id, OP, { now: T0 });
    await expect(s.publishVersion(n.id, { kind: "correction", changeNote: "x", patch: { aiUsageChange: "AKIAIOSFODNN7EXAMPLE" } }, OP)).rejects.toMatchObject({ code: "secret_detected" });
  });
  test("lengths: title ≤120, each body ≤4000, both bodies ≤8000 together", async () => {
    await expect(draft({ title: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(draft({ title: "x".repeat(121) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(draft({ changeSummary: "x".repeat(4001) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(draft({ changeSummary: "x".repeat(4000), aiUsageChange: "y".repeat(4001) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(draft({ relatedFlags: Array.from({ length: 11 }, (_, i) => `F_${i}`) })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("visibility: org / employee only from the scope; org A's notice never reaches org B", () => {
  test("'all' (non-sticky) → orgs created before publish; sticky → also new orgs", async () => {
    await published({ title: "all" });
    await published({ title: "sticky", sticky: true });
    expect(await titles(A1)).toEqual(["all", "sticky"]);
    expect(await titles(B1)).toEqual(["all", "sticky"]);
    expect(await titles(C1)).toEqual(["sticky"]);
  });
  test("'orgs' → only that org; 'employees' → only that employee", async () => {
    await published({ title: "org A only", audienceScope: "orgs" }, [{ orgId: OA, employeeId: null }]);
    await published({ title: "a1 only", audienceScope: "employees" }, [{ orgId: OA, employeeId: A1.employeeId }]);
    expect(await titles(A1)).toEqual(["a1 only", "org A only"]);
    expect(await titles(A2)).toEqual(["org A only"]);
    expect(await titles(B1)).toEqual([]);
  });
  test("org B: getVisible by id → null (not_found), no receipt, not counted", async () => {
    const n = await published({ title: "org A only", audienceScope: "orgs", severity: "urgent" }, [{ orgId: OA, employeeId: null }]);
    expect(await s.getVisible(B1, n.id)).toBeNull();
    await s.recordListed(B1, [n.id]);
    expect(await s.getReceipts(B1, [n.id])).toEqual([]);
    expect(await s.countForWhoami(B1)).toEqual({ unread: 0, urgentUnread: 0, pendingApply: 0 });
    expect(await s.countForWhoami(A1)).toEqual({ unread: 1, urgentUnread: 1, pendingApply: 1 });
  });
  test("a scope whose employee is not in its org sees nothing (not even 'all')", async () => {
    await published({ title: "all", sticky: true });
    expect(await titles({ orgId: OB, employeeId: A1.employeeId })).toEqual([]);
  });
  test("draft, withdrawn, expired and future-expired: only live published notices", async () => {
    await draft({ title: "draft" });
    const w = await published({ title: "withdrawn" });
    await s.withdraw(w.id, OP);
    await published({ title: "expired", expiresAt: "2026-10-12T00:00:01Z" });
    expect(await titles(A1, new Date("2026-10-12T00:00:02Z"))).toEqual([]);
  });
  test("the visible view carries no audience details (no other targets)", async () => {
    const n = await published({ title: "two orgs", audienceScope: "orgs" }, [{ orgId: OA, employeeId: null }, { orgId: OB, employeeId: null }]);
    const v = await s.getVisible(A1, n.id);
    expect(v).not.toBeNull();
    expect(JSON.stringify(v)).not.toContain(OB);
    expect(v as object).not.toHaveProperty("targets");
  });
});

describe("targets and audience", () => {
  test("employee target must belong to the target org (operator_notice_cross_org)", async () => {
    const n = await draft({ audienceScope: "employees" });
    await expect(s.setTargets(n.id, [{ orgId: OA, employeeId: B1.employeeId }], OP)).rejects.toMatchObject({ code: "cross_org" });
  });
  test("target shape must match the scope; 'orgs'/'employees' cannot publish without a target", async () => {
    const all = await draft();
    await expect(s.setTargets(all.id, [{ orgId: OA, employeeId: null }], OP)).rejects.toMatchObject({ code: "scope_mismatch" });
    const orgs = await draft({ audienceScope: "orgs" });
    await expect(s.setTargets(orgs.id, [{ orgId: OA, employeeId: A1.employeeId }], OP)).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(s.publish(orgs.id, OP)).rejects.toMatchObject({ code: "no_targets" });
  });
  test("after publish: targets and audience are locked; a withdrawn notice can't come back", async () => {
    const n = await published({ audienceScope: "orgs" }, [{ orgId: OA, employeeId: null }]);
    await expect(s.setTargets(n.id, [{ orgId: OA, employeeId: null }, { orgId: OB, employeeId: null }], OP)).rejects.toMatchObject({ code: "targets_locked" });
    await expect(s.updateDraft(n.id, { title: "x" }, OP)).rejects.toMatchObject({ code: "not_draft" });
    await s.withdraw(n.id, OP);
    await expect(s.publish(n.id, OP)).rejects.toMatchObject({ code: "not_draft" });
    expect(await titles(A1)).toEqual([]);
  });
});

describe("versions: correction re-opens, minor does not (unless apply-relevant fields change)", () => {
  test("correction → unread again for an employee who acked the old version", async () => {
    const n = await published({ title: "v" });
    await s.recordListed(A1, [n.id]);
    await s.__demoAckForTests(A1, n.id, 1, "applied");
    expect((await s.countForWhoami(A1)).unread).toBe(0);
    const v2 = await s.publishVersion(n.id, { kind: "correction", changeNote: "手順を訂正", patch: { changeSummary: "訂正後" } }, OP);
    expect(v2).toMatchObject({ version: 2, ackRequiredVersion: 2 });
    expect((await s.countForWhoami(A1)).unread).toBe(1);
  });
  test("minor (typo) keeps it read; a minor that touches aiUsageChange / applyMode becomes a correction", async () => {
    const n = await published({ title: "v" });
    await s.recordListed(A1, [n.id]);
    await s.__demoAckForTests(A1, n.id, 1, "read");
    const v2 = await s.publishVersion(n.id, { kind: "minor", changeNote: "誤字", patch: { changeSummary: "誤字修正" } }, OP);
    expect(v2).toMatchObject({ version: 2, ackRequiredVersion: 1 });
    expect((await s.countForWhoami(A1)).unread).toBe(0);
    const v3 = await s.publishVersion(n.id, { kind: "minor", changeNote: "誤字", patch: { aiUsageChange: "使い方が変わった" } }, OP);
    expect(v3).toMatchObject({ version: 3, ackRequiredVersion: 3 });
    expect(s.__demoVersionsForTests(n.id).map((v) => v.kind)).toEqual(["initial", "minor", "correction"]);
    expect((await s.countForWhoami(A1)).unread).toBe(1);
  });
  test("version history is append-only (returned copies can't change the record)", async () => {
    const n = await published({ title: "v" });
    const hist = s.__demoVersionsForTests(n.id);
    hist[0].title = "rewritten";
    expect(s.__demoVersionsForTests(n.id)[0].title).toBe("v");
  });
});

describe("receipts", () => {
  test("recordListed is idempotent and keeps first_listed_at", async () => {
    const n = await published({ title: "r" });
    await s.recordListed(A1, [n.id]);
    const [r1] = await s.getReceipts(A1, [n.id]);
    await s.recordListed(A1, [n.id]);
    const [r2] = await s.getReceipts(A1, [n.id]);
    expect(r1.state).toBe("delivered");
    expect(r2.firstListedAt).toBe(r1.firstListedAt);
    expect(await s.getReceipts(A2, [n.id])).toEqual([]);
  });
});
