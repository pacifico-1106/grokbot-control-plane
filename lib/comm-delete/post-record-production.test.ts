/**
 * Production-mode lookup (Supabase admin client mocked, no network): the
 * query is always scoped to org_id + employee_id + action + time window, the
 * returned rows are re-checked in code, and any error fails closed.
 */
import { describe, expect, mock, test } from "bun:test";

type Filter = [string, string, unknown];
let filters: Filter[] = [];
let rows: Array<Record<string, unknown>> = [];
let failWith: string | null = null;
let approval: Record<string, unknown> | null = null;

function builder() {
  const b = {
    select: () => b,
    eq: (col: string, v: unknown) => { filters.push(["eq", col, v]); return b; },
    in: (col: string, v: unknown) => { filters.push(["in", col, v]); return b; },
    gte: (col: string, v: unknown) => { filters.push(["gte", col, v]); return b; },
    order: () => b,
    limit: async () => (failWith ? { data: null, error: { message: failWith } } : { data: rows, error: null }),
  };
  return b;
}

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => ({ from: (t: string) => { filters.push(["from", t, null]); return builder(); } }) }));
mock.module("@/lib/data/approvals", () => ({ getApprovalById: async () => approval }));
const { findOwnPostRecord, findOwnDeleteDone } = await import("./post-record");
const hasFilter = (f: Filter) => filters.some((x) => JSON.stringify(x) === JSON.stringify(f));

const ORG = "org_a";
const EMP = "emp_a";
const target = { surface: "slack" as const, channel: "C0123ABCD", messageId: "1787911800.000100" };
const since = new Date(Date.now() - 3600_000).toISOString();
const scope = { orgId: ORG, employeeId: EMP, target, sinceIso: since };
const row = (patch: Record<string, unknown>) => ({
  id: "aud_1", org_id: ORG, employee_id: EMP, action: "tool.invoke", created_at: new Date().toISOString(),
  metadata: { postRecord: { v: 1, surface: "slack", channel: target.channel, messageId: target.messageId, postedVia: "bot" } },
  ...patch,
});

describe("production lookup", () => {
  test("query is scoped to org + employee + actions + window + exact ids", async () => {
    filters = []; rows = [row({})]; failWith = null;
    const r = await findOwnPostRecord(scope);
    expect(r).toMatchObject({ ok: true, found: { postedVia: "bot", source: "post_record", auditId: "aud_1" } });
    expect(hasFilter(["from", "audit_events", null])).toBe(true);
    expect(hasFilter(["eq", "org_id", ORG])).toBe(true);
    expect(hasFilter(["eq", "employee_id", EMP])).toBe(true);
    expect(hasFilter(["in", "action", ["tool.invoke", "slack.posted"]])).toBe(true);
    expect(hasFilter(["gte", "created_at", since])).toBe(true);
    expect(hasFilter(["eq", "metadata->postRecord->>channel", target.channel])).toBe(true);
    expect(hasFilter(["eq", "metadata->postRecord->>messageId", target.messageId])).toBe(true);
  });

  test("rows from another org / employee / outside the window are ignored even if returned", async () => {
    for (const bad of [{ org_id: "org_b" }, { employee_id: "emp_b" }, { created_at: new Date(Date.now() - 7200_000).toISOString() }]) {
      filters = []; rows = [row(bad)]; failWith = null; approval = null;
      expect(await findOwnPostRecord(scope)).toEqual({ ok: true, found: null });
    }
  });

  test("a query error fails closed (comm_delete_unavailable), for records and for delete history", async () => {
    filters = []; rows = []; failWith = "boom";
    expect(await findOwnPostRecord(scope)).toEqual({ ok: false, code: "comm_delete_unavailable" });
    expect(await findOwnDeleteDone(scope)).toEqual({ ok: false, code: "comm_delete_unavailable" });
  });

  test("legacy approved post: approval of another employee or with a different fulfilled ts → not found", async () => {
    failWith = null;
    const legacyRow = row({ action: "slack.posted", metadata: { approvalId: "apr_1", channel: target.channel, ts: target.messageId, phase: "approval.fulfill" } });
    rows = [legacyRow];
    approval = { orgId: ORG, employeeId: "emp_b", metadata: { fulfillment: { ok: true, channel: target.channel, ts: target.messageId }, invoke: { postingAs: "bot" } } };
    expect(await findOwnPostRecord(scope)).toEqual({ ok: true, found: null });
    approval = { orgId: ORG, employeeId: EMP, metadata: { fulfillment: { ok: true, channel: target.channel, ts: "1787911800.999999" }, invoke: { postingAs: "bot" } } };
    expect(await findOwnPostRecord(scope)).toEqual({ ok: true, found: null });
    approval = { orgId: ORG, employeeId: EMP, metadata: { fulfillment: { ok: true, channel: target.channel, ts: target.messageId }, invoke: { postingAs: "user" } } };
    expect(await findOwnPostRecord(scope)).toMatchObject({ ok: true, found: { postedVia: "user", source: "legacy_approved_post", approvalId: "apr_1" } });
  });
});
