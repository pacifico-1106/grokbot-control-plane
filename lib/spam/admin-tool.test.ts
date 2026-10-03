import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillSpamAccountsAction, handleSpamAdminTool } from "./admin-tool";
import { createMemorySpamStore, spamOrg } from "./testing";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest } from "@/lib/types";

const OPS = "92f3617c-0000-4000-8000-000000000000";
const O1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U1 = "bbbbbbbb-0000-4000-8000-000000000001";
const YASAKA = "cccccccc-0000-4000-8000-000000000001";
const KEYS = ["SPAM_ADMIN_TOOLS_ENABLED", "PLATFORM_OPS_ORG_ID", "SPAM_ACCOUNTS_APPROVER_USER_IDS"];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { KEYS.forEach((k) => delete process.env[k]); process.env.PLATFORM_OPS_ORG_ID = OPS; process.env.SPAM_ACCOUNTS_APPROVER_USER_IDS = YASAKA; });
afterEach(() => KEYS.forEach((k) => (backup[k] === undefined ? delete process.env[k] : (process.env[k] = backup[k]))));

const cred = { orgId: OPS, actorId: "agent", grokBotAgentId: "grok_ops", generation: 1 } as unknown as ResolvedAdminCredential;
const actor = { email: "ops@example.jp", userId: "u-ops", orgId: OPS };

function queueSpy() {
  const calls: Array<Record<string, unknown>> = [];
  const queue = (async (input: Record<string, unknown>) => {
    calls.push(input);
    return { ok: false, code: "needs_approval", needs_approval: true, approvalId: "apr_1", always_human: true };
  }) as unknown as typeof import("@/lib/admin-mcp/queue").queueAdminTool;
  return { calls, queue };
}

describe("handleSpamAdminTool", () => {
  test("flag OFF (default) → feature_disabled, store untouched", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    for (const name of ["spam.scan", "accounts.suspend", "accounts.unsuspend", "accounts.delete"] as const) {
      const out = await handleSpamAdminTool(name, { orgIds: [O1], reason: "spam wave" }, cred, actor, { store });
      expect(out.isError).toBe(true);
      expect(out.data.code).toBe("feature_disabled");
    }
    expect(store.calls).toEqual([]);
  });

  test("spam.scan is read-only", async () => {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const store = createMemorySpamStore();
    const out = await handleSpamAdminTool("spam.scan", { days: 999 }, cred, actor, { store });
    expect(out.data).toMatchObject({ ok: true, readOnly: true, windowDays: 180 });
    expect(store.calls).toEqual(["scanFacts"]);
  });

  test("dryRun defaults to true and never queues or writes", async () => {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const q = queueSpy();
    const out = await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave" }, cred, actor, { store, queue: q.queue });
    expect(out.data).toMatchObject({ ok: true, dryRun: true });
    expect(q.calls.length).toBe(0);
    expect(store.calls.some((c) => c.startsWith("ban:") || c.startsWith("members:"))).toBe(false);
  });

  test("dryRun:false requires matching previewHash; queues always_human ticket without writes", async () => {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const q = queueSpy();
    const dry = await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave" }, cred, actor, { store, queue: q.queue });
    const hash = (dry.data.plan as { previewHash: string }).previewHash;

    expect((await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave", dryRun: false }, cred, actor, { store, queue: q.queue })).data.code).toBe("preview_hash_required");
    expect((await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave", dryRun: false, previewHash: "0".repeat(64) }, cred, actor, { store, queue: q.queue })).data.code).toBe("preview_hash_mismatch");

    const out = await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave", dryRun: false, previewHash: hash }, cred, actor, { store, queue: q.queue });
    expect(out.data.needs_approval).toBe(true);
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].tool).toBe("accounts.suspend");
    expect((q.calls[0].args as Record<string, unknown>).previewHash).toBe(hash);
    expect(Object.keys(q.calls[0].rawArgsForSecretScan as object)).not.toContain("previewHash");
    expect(store.calls.some((c) => c.startsWith("ban:") || c.startsWith("members:"))).toBe(false);
  });

  test("blocked targets cannot be queued", async () => {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const store = createMemorySpamStore({ orgs: [spamOrg(OPS, U1)] });
    const q = queueSpy();
    const dry = await handleSpamAdminTool("accounts.suspend", { orgIds: [OPS], reason: "spam wave" }, cred, actor, { store, queue: q.queue });
    const hash = (dry.data.plan as { previewHash: string }).previewHash;
    const out = await handleSpamAdminTool("accounts.suspend", { orgIds: [OPS], reason: "spam wave", dryRun: false, previewHash: hash }, cred, actor, { store, queue: q.queue });
    expect(out.data.code).toBe("ineligible_targets");
    expect(q.calls.length).toBe(0);
  });
});

describe("fulfillSpamAccountsAction", () => {
  async function approvedTicket(store: ReturnType<typeof createMemorySpamStore>, resolvedBy = "boss@example.jp") {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    const dry = await handleSpamAdminTool("accounts.suspend", { orgIds: [O1], reason: "spam wave" }, cred, actor, { store });
    const previewHash = (dry.data.plan as { previewHash: string }).previewHash;
    const approval = {
      id: "apr_1", orgId: OPS, status: "approved", resolvedBy, tool: "accounts.suspend",
      metadata: { adminTool: "accounts.suspend", adminRequester: { actorId: "agent" } },
    } as unknown as ApprovalRequest;
    return { approval, args: { action: "suspend", orgIds: [O1], reason: "spam wave", previewHash } };
  }
  const approverOk = {
    listMembers: async () => [{ id: "m", orgId: OPS, email: "boss@example.jp", displayName: "", role: "owner" as const, status: "active" as const, userId: YASAKA }],
    getAuthUser: async () => ({ id: YASAKA, email: "boss@example.jp", emailConfirmedAt: "2026-01-01T00:00:00Z", bannedUntil: null }),
    demo: false,
  };

  test("approved by 八坂 → executes", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const { approval, args } = await approvedTicket(store);
    const f = await fulfillSpamAccountsAction(approval, args, { store, approver: approverOk });
    expect(f.ok).toBe(true);
    expect(store.calls).toContain(`ban:${U1}`);
    expect(store.actions[0].row?.approver).toBe(YASAKA);
  });

  test("flag turned OFF after approval → no writes", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const { approval, args } = await approvedTicket(store);
    delete process.env.SPAM_ADMIN_TOOLS_ENABLED;
    const f = await fulfillSpamAccountsAction(approval, args, { store, approver: approverOk });
    expect(f).toMatchObject({ ok: false, error: "feature_disabled" });
    expect(store.calls.some((c) => c.startsWith("ban:"))).toBe(false);
  });

  test("approved by someone else (e.g. Telegram) → no writes", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const { approval, args } = await approvedTicket(store, "telegram:123");
    const f = await fulfillSpamAccountsAction(approval, args, { store, approver: approverOk });
    expect(f).toMatchObject({ ok: false, error: "approver_channel_not_allowed" });
    expect(store.calls.some((c) => c.startsWith("ban:"))).toBe(false);
  });

  test("state changed since approval → plan_changed_since_approval, no writes", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const { approval, args } = await approvedTicket(store);
    store.orgs[0].stripeCustomerId = "cus_new";
    const f = await fulfillSpamAccountsAction(approval, args, { store, approver: approverOk });
    expect(f).toMatchObject({ ok: false, error: "plan_changed_since_approval" });
    expect(store.calls.some((c) => c.startsWith("ban:"))).toBe(false);
  });

  test("tool/action mismatch is refused", async () => {
    const store = createMemorySpamStore({ orgs: [spamOrg(O1, U1)] });
    const { approval, args } = await approvedTicket(store);
    const f = await fulfillSpamAccountsAction(approval, { ...args, action: "delete" }, { store, approver: approverOk });
    expect(f).toMatchObject({ ok: false, error: "action_mismatch" });
  });
});
