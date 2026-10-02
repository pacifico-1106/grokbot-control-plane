import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool, ADMIN_MCP_TOOLS } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { getToolApprovalKind } from "@/lib/approval-kind-routes/tool-kind-map";
import { isAdminToolAvailableForPlan } from "@/lib/billing/plan-scopes";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  getChannelScopeChannel,
  listEmployeeChannelMemberships,
  setOrgChannelScopePolicy,
  upsertEmployeeChannelMembership,
} from "./data";
import {
  createSlackRateLimiter,
  listSlackConversationsForToken,
  planChannelScopeReconcile,
  reconcileEmployeeChannelScope,
  runChannelScopeReconcileCron,
  type ListedConversation,
  type UsersConversationsPage,
} from "./reconcile";
import { resolveEffectiveChannelScope } from "./resolve";
import { defaultChannelScopePolicy } from "./validate";
import type { ChannelScopeChannel, ChannelScopePolicy, EmployeeChannelMembership } from "./types";

const ORG = DEMO_ORG.id;
const ME = "U0RECON";
const HOME = "T0SPACE";
const PEER = "T0PEER";
const USER_TOKEN = "xoxp-recon-test";
const BOT_TOKEN = "xoxb-recon-test";
const saved = { scope: process.env.P1_CHANNEL_SCOPE_ENABLED, connect: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED };
const savedFetch = globalThis.fetch;
let seq = 0;
let employeeId = "";
let restoreAllowed: (() => void) | null = null;
/** token → channels listed by users.conversations */
let listed: Record<string, ListedConversation[]> = {};
let slackCalls: string[] = [];

const chan = () => `C0RC${Date.now().toString(36).toUpperCase()}${(seq += 1)}`;
const internal = (id: string): ListedConversation => ({ id, is_ext_shared: false, is_shared: false, context_team_id: HOME });
const connect = (id: string): ListedConversation => ({ id, is_ext_shared: true, is_shared: true, context_team_id: HOME, connected_team_ids: [HOME, PEER] });
const policy = (p: Partial<ChannelScopePolicy>): ChannelScopePolicy => ({ ...defaultChannelScopePolicy(), ...p });
const noSleep = async () => undefined;
const fastDeps = () => ({ limiter: createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }), sleep: noSleep });

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}
const call = async (name: string, args: Record<string, unknown>) =>
  (await callAdminMcpTool(name, args, demoCred())).structuredContent as Record<string, unknown>;

beforeEach(async () => {
  process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
  __resetChannelScopeDemoStore();
  listed = {};
  slackCalls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://slack.com/api/users.conversations")) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      const token = auth.replace(/^Bearer /, "");
      slackCalls.push(token);
      return new Response(JSON.stringify({ ok: true, channels: listed[token] ?? [], response_metadata: { next_cursor: "" } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  employeeId = emp.id;
  const prev = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: ME }];
  restoreAllowed = () => {
    emp.allowedAccounts = prev;
  };
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  await bindEmployeeSlackIdentity({ employeeId, orgId: ORG, slackUserId: ME, slackTeamId: HOME, displayName: "稲盛", userToken: USER_TOKEN });
  await setOrgInternalAudienceRule(ORG, { slackTeamIds: [HOME], autoSlackTeamInternal: true }, "test");
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId, orgId: ORG });
  restoreAllowed?.();
  clearDemoRule();
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} });
});

afterAll(() => {
  if (saved.scope === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.scope;
  if (saved.connect === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
  else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = saved.connect;
});

const memberships = async () => listEmployeeChannelMemberships(ORG, { employeeId, limit: 500 });
const membershipOf = async (c: string, via = "user") => (await memberships()).find((m) => m.externalId === c && m.via === via);

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

function mem(externalId: string, state: EmployeeChannelMembership["state"], via: "user" | "bot" = "user"): EmployeeChannelMembership {
  return {
    id: `m_${externalId}`, orgId: ORG, employeeId: "e1", surface: "slack", externalId, via, state,
    inviterSlackUserId: null, inviterTeamId: null, joinedAt: null, leftAt: null, lastEventId: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
}
const scopeOf = (p: Partial<ChannelScopePolicy>, connectEnabled = false) =>
  resolveEffectiveChannelScope({ orgPolicy: policy(p), flags: { enabled: true, connectEnabled } });

describe("planChannelScopeReconcile (pure)", () => {
  test("all_joined: missed internal join ⇒ add member + new ledger row; Connect excluded ⇒ add out_of_scope", () => {
    const items = planChannelScopeReconcile({
      via: "user",
      scope: scopeOf({ mode: "all_joined" }),
      listing: { complete: true, channels: [internal("C0AAA"), connect("C0BBB")] },
      memberships: [],
      ledger: new Map(),
      internalSlackTeamIds: [HOME],
    });
    const a = items.find((i) => i.channelId === "C0AAA")!;
    const b = items.find((i) => i.channelId === "C0BBB")!;
    expect(a).toMatchObject({ action: "add", state: "member", widens: true });
    expect(a.ledger?.to.classification).toBe("internal");
    expect(b).toMatchObject({ action: "add", state: "out_of_scope", widens: false });
    expect(b.ledger?.to).toMatchObject({ classification: "shared_external", mixed: true, externalTeamIds: [PEER] });
  });

  test("registered_only: records out_of_scope only, never creates ledger rows", () => {
    const items = planChannelScopeReconcile({
      via: "user",
      scope: scopeOf({ mode: "registered_only" }),
      listing: { complete: true, channels: [internal("C0AAA")] },
      memberships: [],
      ledger: new Map(),
      internalSlackTeamIds: [HOME],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: "add", state: "out_of_scope", widens: false });
    expect(items[0].ledger).toBeUndefined();
  });

  test("later sharing ⇒ stricter ledger and member → out_of_scope (Connect not included)", () => {
    const row: ChannelScopeChannel = { externalId: "C0SHR", classification: "internal", mixed: false, source: "auto_join" };
    const items = planChannelScopeReconcile({
      via: "user",
      scope: scopeOf({ mode: "all_joined" }),
      listing: { complete: true, channels: [connect("C0SHR")] },
      memberships: [mem("C0SHR", "member")],
      ledger: new Map([["C0SHR", row]]),
      internalSlackTeamIds: [HOME],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: "out_of_scope", state: "out_of_scope", previousState: "member", widens: false });
    expect(items[0].ledger?.from).toEqual({ classification: "internal", mixed: false });
    expect(items[0].ledger?.to.classification).toBe("shared_external");
  });

  test("leaves only from a complete listing; bot via ⇒ removed", () => {
    const input = {
      via: "bot" as const,
      scope: scopeOf({ mode: "all_joined" }),
      memberships: [mem("C0GONE", "member", "bot"), mem("C0OLD", "left", "bot")],
      ledger: new Map<string, ChannelScopeChannel>(),
      internalSlackTeamIds: [HOME],
    };
    const full = planChannelScopeReconcile({ ...input, listing: { complete: true, channels: [] } });
    expect(full).toHaveLength(1);
    expect((full)[0]).toMatchObject({ action: "leave", channelId: "C0GONE", state: "removed", via: "bot" });
    const partial = planChannelScopeReconcile({ ...input, listing: { complete: false, channels: [] } });
    expect(partial).toEqual([]);
  });

  test("never moves a human row toward internal; auto 'unknown' may be refined (flagged as widening)", () => {
    const manual: ChannelScopeChannel = { externalId: "C0MAN", classification: "unknown", mixed: false, source: "manual" };
    const confirmed: ChannelScopeChannel = { externalId: "C0CNF", classification: "unknown", mixed: false, source: "auto_join", humanConfirmedAt: "2026-10-01T00:00:00Z" };
    const auto: ChannelScopeChannel = { externalId: "C0AUT", classification: "unknown", mixed: false, source: "auto_join" };
    const items = planChannelScopeReconcile({
      via: "user",
      scope: scopeOf({ mode: "all_joined" }),
      listing: { complete: true, channels: [internal("C0MAN"), internal("C0CNF"), internal("C0AUT")] },
      memberships: [mem("C0MAN", "member"), mem("C0CNF", "member"), mem("C0AUT", "member")],
      ledger: new Map([["C0MAN", manual], ["C0CNF", confirmed], ["C0AUT", auto]]),
      internalSlackTeamIds: [HOME],
    });
    expect(items.find((i) => i.channelId === "C0MAN")).toBeUndefined();
    expect(items.find((i) => i.channelId === "C0CNF")).toBeUndefined();
    expect(items.find((i) => i.channelId === "C0AUT")).toMatchObject({ action: "stricter", widens: true });
  });

  test("backfill after switching to all_joined: out_of_scope internal ⇒ in_scope", () => {
    const row: ChannelScopeChannel = { externalId: "C0BF", classification: "internal", mixed: false, source: "manual" };
    const items = planChannelScopeReconcile({
      via: "user",
      scope: scopeOf({ mode: "all_joined" }),
      listing: { complete: true, channels: [internal("C0BF")] },
      memberships: [mem("C0BF", "out_of_scope")],
      ledger: new Map([["C0BF", row]]),
      internalSlackTeamIds: [HOME],
    });
    expect(items).toHaveLength(1);
    expect((items)[0]).toMatchObject({ action: "in_scope", state: "member", widens: true });
  });

  test("Connect stays out_of_scope unless includeSlackConnect (and the Connect flag) are ON", () => {
    const row: ChannelScopeChannel = { externalId: "C0CX", classification: "shared_external", mixed: true, source: "auto_join", externalTeamIds: [PEER] };
    const base = {
      via: "user" as const,
      listing: { complete: true, channels: [connect("C0CX")] },
      memberships: [mem("C0CX", "out_of_scope")],
      ledger: new Map([["C0CX", row]]),
      internalSlackTeamIds: [HOME],
    };
    expect(planChannelScopeReconcile({ ...base, scope: scopeOf({ mode: "all_joined", includeSlackConnect: true }, false) })).toEqual([]);
    expect(planChannelScopeReconcile({ ...base, scope: scopeOf({ mode: "all_joined", includeSlackConnect: true }, true) })).toHaveLength(1);
    expect((planChannelScopeReconcile({ ...base, scope: scopeOf({ mode: "all_joined", includeSlackConnect: true }, true) }))[0]).toMatchObject({ action: "in_scope", state: "member" });
  });
});

// ---------------------------------------------------------------------------
// Listing: paging, rate limiting, backoff
// ---------------------------------------------------------------------------

describe("listSlackConversationsForToken", () => {
  test("follows cursors and dedupes", async () => {
    const pages: Record<string, UsersConversationsPage> = {
      "": { ok: true, channels: [internal("C0P1"), internal("C0P2")], nextCursor: "c2" },
      c2: { ok: true, channels: [internal("C0P2"), internal("C0P3")], nextCursor: null },
    };
    const seen: (string | null)[] = [];
    const out = await listSlackConversationsForToken("t", {
      limiter: createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }),
      fetchPage: async (_t, cursor) => {
        seen.push(cursor);
        return pages[cursor ?? ""];
      },
    });
    expect(seen).toEqual([null, "c2"]);
    expect(out.complete).toBe(true);
    expect(out.channels.map((c) => c.id)).toEqual(["C0P1", "C0P2", "C0P3"]);
    expect(out.requests).toBe(2);
  });

  test("429 with a short Retry-After ⇒ waits and retries the same cursor", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const out = await listSlackConversationsForToken("t", {
      limiter: createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchPage: async () => (n++ === 0 ? { ok: false, rateLimited: true, retryAfterSec: 2 } : { ok: true, channels: [internal("C0RL")], nextCursor: null }),
    });
    expect(sleeps).toEqual([2000]);
    expect(out).toMatchObject({ complete: true, retries: 1, rateLimited: false });
  });

  test("429 with a long Retry-After ⇒ stops incomplete (no leaves can be derived)", async () => {
    const out = await listSlackConversationsForToken("t", {
      limiter: createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }),
      sleep: noSleep,
      fetchPage: async () => ({ ok: false, rateLimited: true, retryAfterSec: 60 }),
    });
    expect(out).toMatchObject({ complete: false, rateLimited: true });
  });

  test("budget exhausted ⇒ incomplete", async () => {
    const out = await listSlackConversationsForToken("t", {
      limiter: createSlackRateLimiter({ minIntervalMs: 0, maxRequests: 1, sleep: noSleep }),
      fetchPage: async () => ({ ok: true, channels: [internal("C0B1")], nextCursor: "more" }),
    });
    expect(out).toMatchObject({ complete: false, budgetExhausted: true, requests: 1 });
  });

  test("limiter spaces calls ≥ 3 s apart (≤ 20 req/min) and respects a deadline", async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = createSlackRateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      deadline: 7_000,
    });
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(true);
    expect(waits).toEqual([3000, 3000]);
    expect(await limiter.acquire()).toBe(false); // would start at 9 s > deadline
  });
});

// ---------------------------------------------------------------------------
// Per employee (demo store)
// ---------------------------------------------------------------------------

describe("reconcileEmployeeChannelScope", () => {
  test("dryRun writes nothing", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    listed[USER_TOKEN] = [internal(c)];
    const before = (await listAuditEvents(ORG)).length;
    const r = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: true, trigger: "admin_mcp", runId: "t1" }, fastDeps());
    const user = r.vias.find((v) => v.via === "user")!;
    expect(user.items).toHaveLength(1);
    expect((user.items)[0]).toMatchObject({ action: "add", channelId: c, state: "member" });
    expect(await membershipOf(c)).toBeUndefined();
    expect(await getChannelScopeChannel(ORG, "slack", c)).toBeNull();
    expect((await listAuditEvents(ORG)).length).toBe(before);
  });

  test("apply: backfills a missed join, records a leave, makes a later share stricter, audits", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const missed = chan();
    const gone = chan();
    const shared = chan();
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: gone, via: "user", state: "member", at: "2026-10-01T00:00:00.000Z" });
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: shared, classification: "internal", skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", shared, { source: "auto_join", humanConfirmedAt: "2026-10-01T00:00:00.000Z" });
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: shared, via: "user", state: "member", at: "2026-10-01T00:00:00.000Z" });
    listed[USER_TOKEN] = [internal(missed), connect(shared)];

    const r = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: false, trigger: "cron", runId: "t2" }, fastDeps());
    const user = r.vias.find((v) => v.via === "user")!;
    expect(user.applied).toMatchObject({ applied: 3, failed: 0 });

    expect((await membershipOf(missed))?.state).toBe("member");
    expect((await getChannelScopeChannel(ORG, "slack", missed))).toMatchObject({ classification: "internal", source: "reconcile" });
    expect((await membershipOf(gone))?.state).toBe("left");
    const sharedRow = await getChannelScopeChannel(ORG, "slack", shared);
    expect(sharedRow).toMatchObject({ classification: "shared_external", mixed: true, source: "auto_join" });
    // Became Connect ⇒ the earlier (internal) confirmation is cleared; a human must confirm again.
    expect(sharedRow?.humanConfirmedAt ?? null).toBeNull();
    expect((await membershipOf(shared))?.state).toBe("out_of_scope");

    const audit = (await listAuditEvents(ORG)).find((e) => e.action === "channel_scope.reconcile_run" && (e.metadata as Record<string, unknown>)?.runId === "t2");
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(USER_TOKEN);
  });

  test("a row changed by a real event after the listing started is not touched", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: c, via: "user", state: "member", at: "2099-01-01T00:00:00.000Z" });
    listed[USER_TOKEN] = [];
    const r = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: false, trigger: "cron", runId: "t3" }, fastDeps());
    const user = r.vias.find((v) => v.via === "user")!;
    expect(user.items).toHaveLength(1);
    expect((user.items)[0]).toMatchObject({ action: "leave", channelId: c });
    expect(user.applied?.skipped).toHaveLength(1);
    expect(user.applied?.skipped[0]).toMatchObject({ reason: "changed_since_listing" });
    expect((await membershipOf(c))?.state).toBe("member");
  });

  test("bot via: adapter bot token, bot removal ⇒ removed; no adapter ⇒ skipped", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId, externalId: c, via: "bot", state: "member", at: "2026-10-01T00:00:00.000Z" });
    const r0 = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: true, trigger: "cron", runId: "t4a" }, fastDeps());
    expect(r0.vias.find((v) => v.via === "bot")).toMatchObject({ status: "skipped", reason: "bot_adapter_not_found" });

    await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: true, config: { teamId: HOME }, secrets: { botToken: BOT_TOKEN } });
    listed[BOT_TOKEN] = [];
    const r = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: false, trigger: "cron", runId: "t4b" }, fastDeps());
    expect(r.vias.find((v) => v.via === "bot")?.status).toBe("reconciled");
    expect(slackCalls).toContain(BOT_TOKEN);
    expect((await membershipOf(c, "bot"))?.state).toBe("removed");
  });

  test("flag OFF ⇒ feature_disabled with no Slack call", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const r = await reconcileEmployeeChannelScope({ orgId: ORG, employeeId, dryRun: false, trigger: "cron", runId: "t5" }, fastDeps());
    expect(r).toMatchObject({ ok: false, code: "feature_disabled" });
    expect(slackCalls).toEqual([]);
  });
});

describe("cron", () => {
  test("flag OFF ⇒ skipped, nothing read", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const r = await runChannelScopeReconcileCron({ deps: { sleep: noSleep } });
    expect(r).toMatchObject({ ok: true, skipped: "flag_off", orgs: 0 });
    expect(slackCalls).toEqual([]);
  });

  test("registered_only employees are skipped; all_joined employees are reconciled", async () => {
    const c = chan();
    listed[USER_TOKEN] = [internal(c)];
    const off = await runChannelScopeReconcileCron({ deps: { sleep: noSleep }, limiterFactory: () => createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }) });
    expect(off.employees.skippedRegisteredOnly).toBeGreaterThanOrEqual(1);
    expect(await membershipOf(c)).toBeUndefined();

    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const on = await runChannelScopeReconcileCron({ deps: { sleep: noSleep }, limiterFactory: () => createSlackRateLimiter({ minIntervalMs: 0, sleep: noSleep }) });
    expect(on.employees.reconciled).toBeGreaterThanOrEqual(1);
    expect((await membershipOf(c))?.state).toBe("member");
  });

  test("time budget ⇒ stops and reports truncation", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    let clock = 0;
    const r = await runChannelScopeReconcileCron({
      now: () => (clock += 100_000),
      timeBudgetMs: 1,
      deps: { sleep: noSleep },
    });
    expect(r.truncatedByTimeBudget).toBe(true);
    expect(slackCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Admin MCP channelScope.reconcile
// ---------------------------------------------------------------------------

describe("channelScope.reconcile (Admin MCP)", () => {
  test("registration: always_human, approvalClass admin, kind=account, proper+", () => {
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes("channelScope.reconcile")).toBe(true);
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "channelScope.reconcile");
    expect(tool?.description).toContain("always_human");
    expect(tool?.approvalClass).toBe("admin");
    expect(getToolApprovalKind("channelScope.reconcile")).toBe("account");
    expect(auditActionForAdminTool("channelScope.reconcile")).toBe("admin.policy");
    expect(isAdminToolAvailableForPlan("channelScope.reconcile", "intern")).toBe(false);
    expect(isAdminToolAvailableForPlan("channelScope.reconcile", "proper")).toBe(true);
  });

  test("flag OFF ⇒ feature_disabled, no ticket", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const data = await call("channelScope.reconcile", { employeeId, dryRun: false });
    expect(data.code).toBe("feature_disabled");
    expect(data.approvalId).toBeUndefined();
  });

  test("dryRun (default) is read-only: plan returned, no ticket, no write", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const c = chan();
    listed[USER_TOKEN] = [internal(c)];
    const data = await call("channelScope.reconcile", { employeeId });
    expect(data).toMatchObject({ ok: true, dryRun: true, readOnly: true });
    expect(data.approvalId).toBeUndefined();
    expect((data.counts as Record<string, number>).add).toBe(1);
    expect(await membershipOf(c)).toBeUndefined();
  });

  test("dryRun=false ⇒ ticket (nothing applied) → owner approves → only approved items applied", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    const a = chan();
    const late = chan();
    listed[USER_TOKEN] = [internal(a)];
    const queued = await call("channelScope.reconcile", { employeeId, dryRun: false });
    expect(queued).toMatchObject({ needs_approval: true, always_human: true, auditClass: "admin", tool: "channelScope.reconcile" });
    expect(String(queued.summary)).toContain("取りこぼした参加の記録: 1件");
    expect(await membershipOf(a)).toBeUndefined();

    // A new channel appears after filing — it is NOT covered by the approval.
    listed[USER_TOKEN] = [internal(a), internal(late)];
    const approval = await getApprovalById(String(queued.approvalId), ORG);
    expect(approval?.status).toBe("pending");
    const approved = await resolveApproval(approval!.id, "approved", "owner@example.com", ORG, { actorId: "mem_human_owner" });
    const fulfilled = await fulfillApprovedAdmin(approved!);
    expect(fulfilled?.ok).toBe(true);
    expect((await membershipOf(a))?.state).toBe("member");
    expect(await membershipOf(late)).toBeUndefined();
    const audit = (await listAuditEvents(ORG)).find(
      (e) => e.action === "channel_scope.reconcile_applied" && (e.metadata as Record<string, unknown>)?.approvalId === approval!.id
    );
    expect((audit?.metadata as Record<string, unknown>)?.newDifferencesNotApplied).toBe(1);
  });

  test("no differences ⇒ no ticket", async () => {
    await setOrgChannelScopePolicy(ORG, policy({ mode: "all_joined" }));
    listed[USER_TOKEN] = [];
    const data = await call("channelScope.reconcile", { employeeId, dryRun: false });
    expect(data.code).toBe("no_change");
    expect(data.approvalId).toBeUndefined();
  });
});
