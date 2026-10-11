/**
 * 木村 #281 review → pre-flag-ON fixes for #280 (specs/kimura-20261005-pr281-followup.md):
 *   1. Telegram: a voter binding only makes the adder "known" while the member
 *      it is tied to is still ACTIVE in the SAME org (not removed / disabled /
 *      invited / another org). Otherwise refused + an ids-only audit row
 *      (channel_classify.join_ignored, reason adder_member_inactive), capped by
 *      the existing once-per-hour-per-org×reason slot.
 *   2. N3: the tenant audit row for no_admin_approver is capped per org
 *      (existing take_channel_stuck_notice slot, once per hour per org), so a
 *      flood of joins cannot flood the tenant's audit log.
 * Flags OFF → unchanged (flag_off, nothing written).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeMemberById, setRuntimeMember } from "@/lib/demo-data";
import { createApproval } from "@/lib/data/approvals";
import { listAuditEvents } from "@/lib/data/audit";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { handleChannelJoin, handleTelegramMyChatMember, setJoinDepsForTests } from "@/lib/channel-classify/join";
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

describe("1. Telegram binding: the tied member must still be active in the same org", () => {
  test("binding → active member of this org → proposal (unchanged)", async () => {
    bindTo("mem_2");
    expect((await handleTelegramMyChatMember(channel, update(222))).state).toBe("created");
    expect(ticketOrgs).toEqual([ORG]);
  });

  test("binding → DISABLED member → refused, no ticket, ids-only audit row", async () => {
    patchMember("mem_3", { status: "disabled" });
    bindTo("mem_3");
    const before = (await auditRows(ORG, "channel_classify.join_ignored", "adder_member_inactive")).length;
    const u = update(222);
    const outcome = await handleTelegramMyChatMember(channel, u);
    expect(outcome).toMatchObject({ state: "skipped", reason: "adder_member_inactive" });
    expect(ticketOrgs.length).toBe(0);
    const rows = await auditRows(ORG, "channel_classify.join_ignored", "adder_member_inactive");
    expect(rows.length).toBe(before + 1);
    const row = rows.find((r) => (r.metadata as Record<string, unknown>).externalId === String(u.my_chat_member.chat.id))!;
    expect(row).toBeTruthy();
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.memberId).toBe("mem_3");
    expect(meta.surface).toBe("telegram");
    // ids only: no name / email of the member
    const json = JSON.stringify(row);
    const m3 = getRuntimeMemberById("mem_3")!;
    expect(json).not.toContain(m3.email);
    expect(json).not.toContain(`"${m3.displayName}"`);
  });

  test("binding → invited (not yet active) member → refused", async () => {
    patchMember("mem_3", { status: "invited" });
    bindTo("mem_3");
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped", reason: "adder_member_inactive" });
  });

  test("binding → removed member (no member row) → refused", async () => {
    bindTo("mem_removed_280");
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped", reason: "adder_member_inactive" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("BOLA: binding → an active member of ANOTHER org → refused", async () => {
    patchMember("mem_other_org_280", { orgId: OTHER_ORG, status: "active" });
    bindTo("mem_other_org_280");
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped", reason: "adder_member_inactive" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("member lookup error → refused (fail-closed)", async () => {
    setJoinDepsForTests({
      telegramVoterMember: async () => "mem_2",
      memberActiveInOrg: async () => { throw new Error("db down"); },
    } as Parameters<typeof setJoinDepsForTests>[0]);
    expect(await handleTelegramMyChatMember(channel, update(222))).toMatchObject({ state: "skipped" });
    expect(ticketOrgs.length).toBe(0);
  });

  test("allowlisted adder whose binding points at a disabled member → refused (binding state wins)", async () => {
    patchMember("mem_3", { status: "disabled" });
    bindTo("mem_3", "111");
    expect(await handleTelegramMyChatMember(channel, update(111))).toMatchObject({ state: "skipped", reason: "adder_member_inactive" });
  });

  test("allowlisted adder with no binding → proposal (unchanged)", async () => {
    setJoinDepsForTests({ telegramVoterMember: async () => null });
    expect((await handleTelegramMyChatMember(channel, update(111))).state).toBe("created");
  });

  test("inactive-member refusals are audited at most once per hour per org (no flood)", async () => {
    patchMember("mem_3", { status: "disabled" });
    bindTo("mem_3");
    const before = (await auditRows(ORG, "channel_classify.join_ignored", "adder_member_inactive")).length;
    for (let i = 0; i < 6; i += 1) await handleTelegramMyChatMember(channel, update(222));
    expect((await auditRows(ORG, "channel_classify.join_ignored", "adder_member_inactive")).length).toBe(before + 1);
  });
});

describe("2. N3: no_admin_approver tenant audit rows are capped per org", () => {
  const sig = (orgId: string) => {
    seq += 1;
    return { orgId, surface: "line" as const, externalId: `Cn3cap${String(seq).padStart(6, "0")}`, trigger: "line_join" as const };
  };

  test("over-cap: 8 no-approver joins in one hour → 8 refusals, no ticket, exactly ONE tenant audit row", async () => {
    hasApprover = false;
    const org = `org_n3cap_${Date.now()}_a`;
    for (let i = 0; i < 8; i += 1) {
      expect((await handleChannelJoin(sig(org))).state).toBe("no_approver");
    }
    expect(ticketOrgs.length).toBe(0);
    const rows = await auditRows(org, "channel_classify.proposal_failed", "no_admin_approver");
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as Record<string, unknown>).auditCap).toBe("once_per_hour_per_org");
  });

  test("BOLA / per-org: one org's flood does not use up another org's row", async () => {
    hasApprover = false;
    const a = `org_n3cap_${Date.now()}_b`;
    const b = `org_n3cap_${Date.now()}_c`;
    for (let i = 0; i < 4; i += 1) await handleChannelJoin(sig(a));
    await handleChannelJoin(sig(b));
    expect((await auditRows(a, "channel_classify.proposal_failed", "no_admin_approver")).length).toBe(1);
    expect((await auditRows(b, "channel_classify.proposal_failed", "no_admin_approver")).length).toBe(1);
  });

  test("a new window (store reset) writes one more row", async () => {
    hasApprover = false;
    const org = `org_n3cap_${Date.now()}_d`;
    await handleChannelJoin(sig(org));
    await handleChannelJoin(sig(org));
    resetDemoChannelClassifyStore();
    await handleChannelJoin(sig(org));
    expect((await auditRows(org, "channel_classify.proposal_failed", "no_admin_approver")).length).toBe(2);
  });
});

describe("flags OFF → unchanged", () => {
  test("proposals flag OFF: flag_off, no audit rows, no ticket", async () => {
    delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
    patchMember("mem_3", { status: "disabled" });
    bindTo("mem_3");
    const before = (await listAuditEvents(ORG, 1_000_000)).length;
    expect((await handleTelegramMyChatMember(channel, update(222))).state).toBe("flag_off");
    hasApprover = false;
    const org = `org_n3cap_${Date.now()}_off`;
    expect((await handleChannelJoin({ orgId: org, surface: "line", externalId: "Cn3capoff0001", trigger: "line_join" })).state).toBe("flag_off");
    expect((await listAuditEvents(ORG, 1_000_000)).length).toBe(before);
    expect((await listAuditEvents(org)).length).toBe(0);
    expect(ticketOrgs.length).toBe(0);
  });
});
