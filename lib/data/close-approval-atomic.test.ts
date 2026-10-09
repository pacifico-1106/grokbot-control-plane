/**
 * 木村 #286 pre-flag item 5: closeApprovalWithoutSend wrote the status and the
 * closedWithoutSend metadata in two separate writes — if the second failed the
 * approval was left "superseded" with no reason. Status + metadata must land
 * in ONE write (migration 20261009150000 close_approval_without_send; before
 * that migration is applied, one PostgREST UPDATE carrying both). Fake
 * Supabase client with one in-memory row; no network.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Row = { id: string; org_id: string; status: string; metadata: Record<string, unknown>; resolved_at: string | null; purpose: string };
const ORG = "00000000-0000-4000-8000-00000000c501";
const OTHER_ORG = "00000000-0000-4000-8000-00000000c502";
const ID = "00000000-0000-4000-8000-00000000c5a1";
let row: Row;
let mode: "ok" | "metadata_write_fails" | "rpc_missing" | "rpc_missing_update_fails" | "write_fails" = "ok";
let writes: Array<{ kind: string; payload: unknown }> = [];
let demo = false;

const actualMode = await import("@/lib/mode");
mock.module("@/lib/mode", () => ({ ...actualMode, isDemoMode: () => demo }));
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "merge_approval_metadata") {
        writes.push({ kind: "merge", payload: args });
        if (mode === "metadata_write_fails" || mode === "write_fails") return Promise.resolve({ data: null, error: { message: "boom" } });
        if (args.p_id !== row.id || args.p_org !== row.org_id) return Promise.resolve({ data: null, error: null });
        row.metadata = { ...row.metadata, ...(args.p_patch as Record<string, unknown>) };
        return Promise.resolve({ data: { ...row }, error: null });
      }
      if (name === "close_approval_without_send") {
        if (mode === "rpc_missing" || mode === "rpc_missing_update_fails") return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function public.close_approval_without_send" } });
        writes.push({ kind: "close_rpc", payload: args });
        if (mode === "metadata_write_fails" || mode === "write_fails") return Promise.resolve({ data: null, error: { message: "boom" } });
        if (args.p_id !== row.id || args.p_org !== row.org_id || !(args.p_from as string[]).includes(row.status)) {
          return Promise.resolve({ data: null, error: null });
        }
        const at = new Date().toISOString();
        row.status = String(args.p_to);
        row.resolved_at = at;
        row.metadata = { ...row.metadata, closedWithoutSend: { ...(args.p_patch as Record<string, unknown>), status: args.p_to, at } };
        return Promise.resolve({ data: { ...row }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
    from(table: string) {
      if (table !== "approval_requests") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, string, unknown]> = [];
      let update: Record<string, unknown> | null = null;
      const matches = () =>
        filters.every(([op, col, v]) => {
          const value = (row as unknown as Record<string, unknown>)[col];
          return op === "eq" ? value === v : op === "in" ? (v as unknown[]).includes(value) : false;
        });
      const chain = {
        select() {
          return chain;
        },
        update(payload: Record<string, unknown>) {
          update = payload;
          return chain;
        },
        eq(col: string, v: unknown) {
          filters.push(["eq", col, v]);
          return chain;
        },
        in(col: string, v: unknown[]) {
          filters.push(["in", col, v]);
          return chain;
        },
        maybeSingle() {
          if (update) {
            writes.push({ kind: "update", payload: update });
            if (mode === "write_fails" || mode === "rpc_missing_update_fails") return Promise.resolve({ data: null, error: { message: "boom" } });
            if (!matches()) return Promise.resolve({ data: null, error: null });
            Object.assign(row, update);
            return Promise.resolve({ data: { ...row }, error: null });
          }
          return Promise.resolve({ data: matches() ? { ...row } : null, error: null });
        },
      };
      return chain;
    },
  }),
}));

const { closeApprovalWithoutSend } = await import("@/lib/data/approvals");

beforeEach(() => {
  row = { id: ID, org_id: ORG, status: "approved", metadata: { invokeSnapshot: { tool: "comm.send" }, statusToken: "st_x" }, resolved_at: null, purpose: "comm.internal" };
  mode = "ok";
  writes = [];
  demo = false;
});
const close = (orgId = ORG, from: Array<"pending" | "approved"> = ["approved"]) =>
  closeApprovalWithoutSend({ approval: { id: ID, orgId }, from, to: "superseded", meta: { reason: "thread_moved_on", phase: "approval.fulfill" } });
const fullyClosed = () =>
  row.status === "superseded" && (row.metadata.closedWithoutSend as Record<string, unknown> | undefined)?.reason === "thread_moved_on";
const untouched = () => row.status === "approved" && row.metadata.closedWithoutSend === undefined && row.resolved_at === null;

describe("closeApprovalWithoutSend: status + reason in ONE write", () => {
  test("success: exactly one write; status, resolved_at and closedWithoutSend land together; other metadata kept", async () => {
    const closed = await close();
    expect(writes.length).toBe(1);
    expect(fullyClosed()).toBe(true);
    expect(row.resolved_at).not.toBeNull();
    expect(row.metadata.statusToken).toBe("st_x");
    expect(row.metadata.invokeSnapshot).toEqual({ tool: "comm.send" });
    expect(closed?.status).toBe("superseded");
    expect((closed?.metadata?.closedWithoutSend as Record<string, unknown>)?.reason).toBe("thread_moved_on");
  });

  test("the metadata write failing leaves NO partial state (never superseded without a reason)", async () => {
    mode = "metadata_write_fails";
    let threw = false;
    const closed = await close().catch(() => {
      threw = true;
      return null;
    });
    expect(closed).toBeNull();
    expect(threw).toBe(true);
    expect(untouched()).toBe(true);
  });

  test("before migration 20261009150000 (RPC missing): ONE UPDATE carries status and metadata", async () => {
    mode = "rpc_missing";
    await close();
    const updates = writes.filter((w) => w.kind === "update");
    expect(updates.length).toBe(1);
    expect(writes.filter((w) => w.kind === "merge").length).toBe(0);
    const payload = updates[0].payload as Record<string, unknown>;
    expect(payload.status).toBe("superseded");
    expect(((payload.metadata as Record<string, unknown>)?.closedWithoutSend as Record<string, unknown>)?.reason).toBe("thread_moved_on");
    expect(fullyClosed()).toBe(true);
    expect(row.metadata.statusToken).toBe("st_x");
  });

  test("fallback UPDATE failing also leaves no partial state (and is reported as a failure)", async () => {
    mode = "rpc_missing_update_fails";
    let threw = false;
    await close().catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    expect(untouched()).toBe(true);
    expect(writes.filter((w) => w.kind === "merge").length).toBe(0);
  });

  test("BOLA: another org's id → null, nothing written to the row", async () => {
    expect(await close(OTHER_ORG)).toBeNull();
    expect(untouched()).toBe(true);
    mode = "rpc_missing";
    expect(await close(OTHER_ORG)).toBeNull();
    expect(untouched()).toBe(true);
  });

  test("status not in `from` (already closed / pending-only close) → null, untouched", async () => {
    expect(await close(ORG, ["pending"])).toBeNull();
    expect(untouched()).toBe(true);
  });
});
