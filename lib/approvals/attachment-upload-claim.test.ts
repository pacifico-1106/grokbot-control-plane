/**
 * Production mode of the attachment upload claim (#252 follow-up 2): the claim
 * is an atomic conditional update in the DB (RPC, row lock on approval_requests,
 * metadata.attachmentUpload). Any RPC error fails CLOSED (no upload).
 * Supabase is mocked; no network. The migration text is pinned too.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let reply: { data: unknown; error: unknown } = { data: null, error: null };
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return reply; },
  }),
}));

const { claimAttachmentUpload, finishAttachmentUpload } = await import("@/lib/approvals/attachment-upload-claim");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
const approval = { id: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-0000000000aa", metadata: {} } as unknown as ApprovalRequest;
const REF = "a".repeat(64);
beforeEach(() => { calls = []; reply = { data: null, error: null }; });

describe("claimAttachmentUpload (production RPC)", () => {
  test("claimed → returns a fresh claim id and calls the RPC with the ref hash", async () => {
    reply = { data: { state: "claimed" }, error: null };
    const out = await claimAttachmentUpload(approval, REF);
    expect(out.kind).toBe("claimed");
    expect(calls[0].name).toBe("claim_approval_attachment_upload");
    expect(calls[0].args).toMatchObject({ p_id: approval.id, p_org: approval.orgId, p_ref: REF });
    expect(String(calls[0].args.p_claim)).toMatch(/^[0-9a-f-]{36}$/);
    if (out.kind === "claimed") expect(out.claimId).toBe(String(calls[0].args.p_claim));
  });
  test("running / uncertain / denied map through", async () => {
    for (const state of ["running", "uncertain", "denied"] as const) {
      reply = { data: { state }, error: null };
      expect((await claimAttachmentUpload(approval, REF)).kind).toBe(state);
    }
  });
  test("succeeded returns the stored upload", async () => {
    reply = { data: { state: "succeeded", upload: { fileId: "F1", filename: "a.pdf", bytes: 3 } }, error: null };
    expect(await claimAttachmentUpload(approval, REF)).toEqual({ kind: "succeeded", fileId: "F1", filename: "a.pdf", bytes: 3 });
  });
  test("RPC error / missing function / garbage → unavailable (fail closed)", async () => {
    for (const r of [{ data: null, error: { message: "function does not exist" } }, { data: null, error: null }, { data: { state: "weird" }, error: null }]) {
      reply = r;
      expect((await claimAttachmentUpload(approval, REF)).kind).toBe("unavailable");
    }
  });
});

describe("finishAttachmentUpload (production RPC)", () => {
  test("passes only allow-listed result fields", async () => {
    reply = { data: true, error: null };
    expect(await finishAttachmentUpload(approval, "claim-1", "succeeded",
      { fileId: "F1", filename: "a.pdf", bytes: 3, code: undefined, fileRef: "https://x.example/secret" } as never)).toBe(true);
    expect(calls[0].name).toBe("finish_approval_attachment_upload");
    expect(calls[0].args).toMatchObject({ p_id: approval.id, p_org: approval.orgId, p_claim: "claim-1", p_state: "succeeded" });
    expect(calls[0].args.p_result).toEqual({ fileId: "F1", filename: "a.pdf", bytes: 3 });
  });
  test("RPC error → false (caller keeps the record as-is: running blocks further uploads)", async () => {
    reply = { data: null, error: { message: "boom" } };
    expect(await finishAttachmentUpload(approval, "claim-1", "failed", { code: "x" })).toBe(false);
  });
});

describe("migration", () => {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_approval_attachment_upload_claim.sql"));
  test("new additive migration: row lock, conditional state, service_role only, no new table/column", () => {
    expect(file).toBeTruthy();
    const sql = readFileSync(join(dir, file!), "utf8");
    expect(sql).toContain("create or replace function public.claim_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_ref text)");
    expect(sql).toContain("create or replace function public.finish_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_state text, p_result jsonb)");
    expect(sql).toMatch(/for update/);
    expect(sql).toContain("security invoker");
    expect(sql).toContain("state' = 'running'");
    expect(sql).toMatch(/revoke all on function public\.claim_approval_attachment_upload\(uuid,uuid,uuid,text\) from public,anon,authenticated/);
    expect(sql).toMatch(/grant execute on function public\.finish_approval_attachment_upload\(uuid,uuid,uuid,text,jsonb\) to service_role/);
    expect(sql).not.toMatch(/create table|alter table/i);
  });
});
