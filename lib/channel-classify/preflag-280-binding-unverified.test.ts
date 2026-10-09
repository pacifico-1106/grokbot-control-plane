/**
 * 木村 review of #299 (before CHANNEL_CLASSIFY_PROPOSALS_ENABLED goes ON):
 *   1. A voter-binding lookup ERROR is a distinct state (not "no binding"): the adder is refused
 *      even when allowlisted — reason adder_member_unverified (ids-only audit, hourly-capped).
 *   2. join_ignored audit: when the shared slot is unavailable, fall back to a per-instance
 *      1-hour window (same as no_admin_approver) instead of dropping the row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeMemberById, setRuntimeMember } from "@/lib/demo-data";
import { createApproval } from "@/lib/data/approvals";
import { listAuditEvents } from "@/lib/data/audit";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { handleTelegramMyChatMember, resetJoinAuditFallbackForTests, setJoinDepsForTests } from "@/lib/channel-classify/join";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import type { OrgMember } from "@/lib/types";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_preflag280_other";
let ticketOrgs: string[] = [];
let hasApprover = true;
let seq = 0;
const restorers: Array<() => void> = [];

const channel = {
  id: "nc_tg_inbox_280",
  orgId: ORG,
  provider: "telegram",
  enabled: true,
  config: { chatId: "-1000000000001", allowedUserIds: ["111"] },
  secrets: {},
} as unknown as NotificationChannelRuntime;

function update(fromId: number) {
  seq += 1;
  return {
    my_chat_member: {
      chat: { id: -1002800000000 - seq, type: "supergroup" },
      from: { id: fromId, is_bot: false },
      old_chat_member: { status: "left", user: { id: 42, is_bot: true } },
      new_chat_member: { status: "member", user: { id: 42, is_bot: true } },
    },
  };
}

function patchMember(id: string, patch: Partial<OrgMember>) {
  const current = getRuntimeMemberById(id);
  if (current) {
    const before = { ...current };
    setRuntimeMember({ ...current, ...patch });
    restorers.push(() => setRuntimeMember(before));
  } else {
    setRuntimeMember({
      id, orgId: ORG, email: `${id}@example.com`, displayName: id, role: "member", status: "active", ...patch,
    } as OrgMember);
  }
}

/** Binding for the given telegram user on THIS inbox / org → memberId. */
function bindTo(memberId: string, userId = "222") {
  setJoinDepsForTests({
    telegramVoterMember: async (orgId, channelKey, uid) =>
      orgId === ORG && channelKey === channel.id && uid === userId ? memberId : null,
  });
}

async function auditRows(orgId: string, action: string, reason: string) {
  return (await listAuditEvents(orgId, 1_000_000)).filter(
    (a) => a.action === action && (a.metadata as Record<string, unknown> | undefined)?.reason === reason
  );
}

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  ticketOrgs = [];
  hasApprover = true;
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => hasApprover,
    createApproval: async (input) => {
      ticketOrgs.push(input.orgId);
      return createApproval(input);
    },
  });
  setStuckNotifyDepsForTests({
    listChannels: async () => [],
    send: async () => ({ ok: true }),
    audit: async () => undefined,
    mail: async () => ({ ok: true }),
  });
});

afterEach(() => {
  while (restorers.length) restorers.pop()!();
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
  setJoinDepsForTests(null);
});

type JoinDeps = NonNullable<Parameters<typeof setJoinDepsForTests>[0]>;
const bindingError = (): Partial<JoinDeps> => ({ telegramVoterBinding: async () => ({ status: "error" as const }) });

describe("1. binding lookup error → distinct state, refused even when allowlisted", () => {
  beforeEach(() => resetJoinAuditFallbackForTests());

  test("allowlisted adder + binding lookup error → refused adder_member_unverified, no ticket", async () => {
    setJoinDepsForTests(bindingError());
    expect(await handleTelegramMyChatMember(channel, update(111))).toMatchObject({ state: "skipped", reason: "adder_member_unverified" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("non-allowlisted adder + binding lookup error → refused adder_member_unverified", async () => {
    setJoinDepsForTests(bindingError());
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped", reason: "adder_member_unverified" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("binding lookup THROWS → same as error (allowlisted still refused)", async () => {
    setJoinDepsForTests({ telegramVoterBinding: async () => { throw new Error("db down"); } });
    expect(await handleTelegramMyChatMember(channel, update(111))).toMatchObject({ state: "skipped", reason: "adder_member_unverified" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("lookup error audit: ids only, capped once per hour per org", async () => {
    setJoinDepsForTests(bindingError());
    const before = (await auditRows(ORG, "channel_classify.join_ignored", "adder_member_unverified")).length;
    for (let i = 0; i < 5; i += 1) await handleTelegramMyChatMember(channel, update(111));
    const rows = await auditRows(ORG, "channel_classify.join_ignored", "adder_member_unverified");
    expect(rows.length).toBe(before + 1);
    const meta = rows[rows.length - 1].metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["auditClass", "externalId", "reason", "surface"]);
  });

  test("status none + allowlisted → proposal (unchanged)", async () => {
    setJoinDepsForTests({ telegramVoterBinding: async () => ({ status: "none" as const }) });
    expect((await handleTelegramMyChatMember(channel, update(111))).state).toBe("created");
  });

  test("status none + not allowlisted → unknown_adder (unchanged)", async () => {
    setJoinDepsForTests({ telegramVoterBinding: async () => ({ status: "none" as const }) });
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped", reason: "unknown_adder" });
  });

  test("status found + active member of this org → proposal (unchanged)", async () => {
    setJoinDepsForTests({ telegramVoterBinding: async () => ({ status: "found" as const, memberId: "mem_2" }) });
    expect((await handleTelegramMyChatMember(channel, update(222))).state).toBe("created");
    expect(ticketOrgs).toEqual([ORG]);
  });

  test("BOLA: binding lookup is scoped to the inbox's own org + inbox id", async () => {
    const seen: string[] = [];
    setJoinDepsForTests({
      telegramVoterBinding: async (orgId, channelKey) => {
        seen.push(`${orgId}|${channelKey}`);
        return { status: "error" as const };
      },
    });
    await handleTelegramMyChatMember(channel, update(111));
    expect(seen).toEqual([`${ORG}|${channel.id}`]);
  });

  test("flag OFF → flag_off, binding lookup never called", async () => {
    delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
    let called = 0;
    setJoinDepsForTests({ telegramVoterBinding: async () => { called += 1; return { status: "error" as const }; } });
    expect(await handleTelegramMyChatMember(channel, update(111))).toEqual({ state: "flag_off" });
    expect(called).toBe(0);
  });
});

describe("2. join_ignored audit: slot unavailable → per-instance 1-hour fallback (not dropped)", () => {
  beforeEach(() => resetJoinAuditFallbackForTests());

  for (const [label, slot] of [
    ["unavailable", async () => ({ state: "unavailable" as const })],
    ["throws", async () => { throw new Error("rpc down"); }],
  ] as const) {
    test(`slot ${label}: first refusal audited, repeats in the hour are not`, async () => {
      let slotCalls = 0;
      setJoinDepsForTests({
        telegramVoterBinding: async () => ({ status: "none" as const }),
        joinAuditSlot: async () => { slotCalls += 1; return slot(); },
      });
      const org = `org_joinfb_${label}_${Date.now()}`;
      const ch = { ...channel, orgId: org } as typeof channel;
      for (let i = 0; i < 6; i += 1) {
        expect(await handleTelegramMyChatMember(ch, update(222))).toMatchObject({ state: "skipped", reason: "unknown_adder" });
      }
      const rows = await auditRows(org, "channel_classify.join_ignored", "unknown_adder");
      expect(slotCalls).toBe(6); // the injected (failing) shared slot was really consulted
      expect(rows.length).toBe(1);
    });
  }

  test("fallback window is per org × reason (another org still gets its one row)", async () => {
    let slotCalls = 0;
    setJoinDepsForTests({
      telegramVoterBinding: async () => ({ status: "none" as const }),
      joinAuditSlot: async () => { slotCalls += 1; return { state: "unavailable" as const }; },
    });
    const a = `org_joinfb_a_${Date.now()}`;
    const b = `org_joinfb_b_${Date.now()}`;
    for (const org of [a, a, b, b]) await handleTelegramMyChatMember({ ...channel, orgId: org } as typeof channel, update(222));
    expect((await auditRows(a, "channel_classify.join_ignored", "unknown_adder")).length).toBe(1);
    expect((await auditRows(b, "channel_classify.join_ignored", "unknown_adder")).length).toBe(1);
    expect(slotCalls).toBe(4);
  });

  test("slot ok + not allowed → no row (shared cap still wins)", async () => {
    setJoinDepsForTests({ telegramVoterBinding: async () => ({ status: "none" as const }), joinAuditSlot: async () => ({ state: "ok" as const, allowed: false }) });
    const org = `org_joinfb_capped_${Date.now()}`;
    await handleTelegramMyChatMember({ ...channel, orgId: org } as typeof channel, update(222));
    expect((await auditRows(org, "channel_classify.join_ignored", "unknown_adder")).length).toBe(0);
  });
});
