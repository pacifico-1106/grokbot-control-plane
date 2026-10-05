/**
 * Follow-up to PR-B: security checks required before the flags go ON
 * (八坂 10/05 policy). Four classes: BOLA (another org's id → refused / never
 * used), RLS (new table service_role only), self-approval (system tickets
 * cannot be resolved by the person who triggered them), and endpoints any
 * authenticated caller could reach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval } from "@/lib/data/approvals";
import { getApprovalById } from "@/lib/data";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { handleTelegramMyChatMember, setJoinDepsForTests } from "@/lib/channel-classify/join";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { buildPartyUpsertCardSummaryJa, setCardBudgetMsForTests } from "@/lib/channel-classify/approval-card";
import { setChannelFactsDepsForTests } from "@/lib/channel-classify/facts";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import { canResolverResolveAdminApproval } from "@/lib/approval-workflow/admin-policy";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const ORG = DEMO_ORG.id;
const OTHER = "org_sec_other_fixture";
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATION = `${root}supabase/migrations/20261005400000_channel_classify_budget.sql`;
const ROLLBACK = `${root}supabase/verification/20261005400000_channel_classify_budget_rollback.sql`;
let ticketOrgs: string[] = [];

function tgInbox(orgId: string, allowed: string[]): NotificationChannelRuntime {
  return { id: `nc_tg_${orgId}`, orgId, provider: "telegram", enabled: true, config: { chatId: "-1000000000009", allowedUserIds: allowed }, secrets: {} } as unknown as NotificationChannelRuntime;
}
const tgUpdate = (fromId: number, chatId: number) => ({
  my_chat_member: {
    chat: { id: chatId, type: "group" },
    from: { id: fromId, is_bot: false },
    old_chat_member: { status: "left", user: { id: 42, is_bot: true } },
    new_chat_member: { status: "member", user: { id: 42, is_bot: true } },
  },
});

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  ticketOrgs = [];
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      ticketOrgs.push(input.orgId);
      return createApproval(input);
    },
  });
  setStuckNotifyDepsForTests({ listChannels: async () => [], send: async () => ({ ok: true }), audit: async () => undefined, mail: async () => ({ ok: true }) });
});

afterEach(() => {
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  delete process.env.CRON_SECRET;
  setProposalDepsForTests(null);
  setJoinDepsForTests(null);
  setStuckNotifyDepsForTests(null);
  setChannelFactsDepsForTests(null);
  setCardBudgetMsForTests(null);
});

describe("BOLA: another org's id is refused / never used", () => {
  test("Telegram: an adder known only in ANOTHER org's inbox does not unlock this org", async () => {
    setJoinDepsForTests({ telegramVoterMember: async (orgId) => (orgId === OTHER ? "member_other" : null) });
    const outcome = await handleTelegramMyChatMember(tgInbox(ORG, []), tgUpdate(555, -1007770001));
    expect(outcome.state).toBe("skipped");
    expect(ticketOrgs).toEqual([]);
  });

  test("Telegram: the ticket org is the verified inbox's org, whatever the update says", async () => {
    const update = { ...tgUpdate(111, -1007770002), orgId: OTHER } as never;
    const outcome = await handleTelegramMyChatMember(tgInbox(ORG, ["111"]), update);
    expect(outcome.state).toBe("created");
    expect(ticketOrgs).toEqual([ORG]);
  });

  test("card facts use the card org's own token only", async () => {
    const tokensFor: string[] = [];
    setCardBudgetMsForTests(50);
    setChannelFactsDepsForTests({
      resolveToken: async (orgId) => { tokensFor.push(orgId); return ""; },
      slackApi: async () => ({ ok: false }),
    });
    await buildPartyUpsertCardSummaryJa(ORG, { kind: "slack_user", identifier: "U0SECCARD1", audience: "internal" });
    expect(tokensFor.every((o) => o === ORG)).toBe(true);
  });
});

describe("RLS: new budget table is server-only", () => {
  test("migration enables RLS, revokes sessions, grants service_role only, no policy; rollback exists", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(ROLLBACK)).toBe(true);
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/alter table public\.channel_classify_budget_windows enable row level security;/);
    expect(sql).toMatch(/revoke all on table public\.channel_classify_budget_windows from public, anon, authenticated;/);
    expect(sql).toMatch(/revoke all on function public\.take_channel_classify_budget\(uuid, text, integer, integer\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.take_channel_classify_budget\(uuid, text, integer, integer\) to service_role;/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toMatch(/^-- ROLLBACK \(down\)/m);
    expect(sql).toMatch(/^-- END ROLLBACK/m);
    // #276's migration is not edited by this PR
    expect(sql).not.toMatch(/channel_classify_proposals\b(?!_)/);
  });

  test("the data layer calls only the new RPC from the new file", () => {
    const data = readFileSync(`${root}lib/data/channel-classify-budget.ts`, "utf8");
    expect([...data.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1])).toEqual(["take_channel_classify_budget"]);
  });
});

describe("self-approval: system tickets cannot be resolved by whoever triggered them", () => {
  test("the Telegram adder is not recorded as requester; a non-owner adder cannot resolve the admin ticket", async () => {
    setJoinDepsForTests({ telegramVoterMember: async (orgId, key, userId) => (userId === "777" ? "member_adder" : null) });
    const outcome = await handleTelegramMyChatMember(tgInbox(ORG, []), tgUpdate(777, -1007770003));
    expect(outcome.state).toBe("created");
    const approval = await getApprovalById(outcome.approvalId!, ORG);
    expect(approval?.metadata?.proposalRequester).toEqual({ kind: "system", source: "telegram_my_chat_member" });
    expect(JSON.stringify(approval?.metadata ?? {})).not.toContain("member_adder");
    expect(JSON.stringify(approval?.metadata ?? {})).not.toContain("777");
    expect(approval?.status).toBe("pending");
    const verdict = canResolverResolveAdminApproval("member_adder", approval!, null, ["member_owner"], true);
    expect(verdict.allowed).toBe(false);
    expect(canResolverResolveAdminApproval("member_owner", approval!, null, ["member_owner"], true).allowed).toBe(true);
  });

  test("summary / no-approver paths never create a ticket anyone could approve", async () => {
    setProposalDepsForTests({
      notifyApproval: async () => true,
      hasApprover: async () => false,
      createApproval: async (input) => { ticketOrgs.push(input.orgId); return createApproval(input); },
    });
    const outcome = await handleTelegramMyChatMember(tgInbox(ORG, ["111"]), tgUpdate(111, -1007770004));
    expect(outcome.state).toBe("no_approver");
    expect(ticketOrgs).toEqual([]);
  });
});

describe("endpoints any authenticated caller could reach", () => {
  test("backfill cron: no secret / a session-like bearer → 401, nothing runs", async () => {
    process.env.CRON_SECRET = "cron-secret-fixture-0123456789";
    const { GET } = await import("@/app/api/cron/channel-classify-backfill/route");
    const noAuth = await GET(new Request("https://example.test/api/cron/channel-classify-backfill"));
    expect(noAuth.status).toBe(401);
    const sessionLike = await GET(new Request("https://example.test/api/cron/channel-classify-backfill", { headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.session.fixture" } }));
    expect(sessionLike.status).toBe(401);
  });

  test("no new HTTP route is added by this PR (join paths stay behind webhook signature / secret)", () => {
    const route = readFileSync(`${root}app/api/webhooks/telegram/[ref]/route.ts`, "utf8");
    const secretCheck = route.indexOf("x-telegram-bot-api-secret-token");
    const joinCall = route.indexOf("handleTelegramMyChatMember");
    expect(secretCheck).toBeGreaterThan(-1);
    expect(joinCall).toBeGreaterThan(secretCheck);
  });
});
