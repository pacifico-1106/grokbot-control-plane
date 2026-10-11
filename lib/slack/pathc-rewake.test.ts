/**
 * Path C re-wake (木村 2026-10-09, PATHC_REWAKE_ON_CLASSIFY_ENABLED, default OFF):
 * once a human approves the classification of a channel whose mention was
 * skipped as unclassified, the latest skipped mention per employee is re-woken
 * EXACTLY ONCE — claimed atomically (migration 20261009700000), only for the
 * approval's own org, only if the approved class allows a Path C wake, and
 * without any message text (the record holds ids + timestamps only).
 *
 * Demo mode, dummy ids, no network (fetch mocked).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { createApproval, getApprovalById, resolveApprovalWithoutWorkflow } from "@/lib/data/approvals";
import {
  claimSkippedChannelWakes,
  listDemoSkippedChannelWakesForTests,
  recordSkippedChannelWake,
  resetDemoSkippedChannelWakes,
} from "@/lib/data/slack-skipped-wakes";
import { rewakeSkippedChannelWakesAfterApproval } from "@/lib/slack/pathc-rewake";
import type { ApprovalRequest } from "@/lib/types";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const ORG = DEMO_ORG.id;
const EMP = "emp_comm";
const SUB = "U0PCSUB001";
const TEAM = "T0PCTEAM01";
const SPEAKER = "U0PCSPEAK1";
const WAKE_URL = "https://example.test/wake/pathc";
const SECRET_TEXT = "PATHC-BODY-請求書の締め日は25日-XYZZY";
const FLAGS = [
  "P0_USER_CHANNEL_MENTION_INGRESS",
  "CHANNEL_STUCK_NOTIFY_ENABLED",
  "CHANNEL_CLASSIFY_PROPOSALS_ENABLED",
  "CHANNEL_STUCK_MAX_NOTICES_PER_HOUR",
  "CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR",
  "PATHC_REWAKE_ON_CLASSIFY_ENABLED",
];
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

let sent: string[] = [];
let audits: Array<{ orgId: string; action: string; summary?: string; metadata?: Record<string, unknown> }> = [];
let tickets: Array<{ orgId: string; summary: string; metadata: unknown }> = [];
let wakes: Array<Record<string, unknown>> = [];
let seq = 0;
let restoreEmp: (() => void) | null = null;

function inbox(orgId: string): NotificationChannelRuntime {
  return { id: `nc_${orgId}`, orgId, provider: "slack", label: "x", enabled: true, isDefault: true, config: {}, secrets: {} } as unknown as NotificationChannelRuntime;
}

function channelId(): string {
  seq += 1;
  return `C0PC${Date.now().toString(36).toUpperCase().slice(-5)}${seq}`.slice(0, 14);
}

function envelope(channel: string, opts: { team?: string; subscriberTeam?: string; text?: string } = {}) {
  seq += 1;
  return {
    type: "event_callback",
    team_id: opts.team ?? TEAM,
    event_id: `Ev0PC${Date.now().toString(36)}${seq}`,
    event: {
      type: "message",
      channel_type: "channel",
      user: SPEAKER,
      text: opts.text ?? `<@${SUB}> ${SECRET_TEXT}`,
      ts: `1788100${String(seq).padStart(3, "0")}.000${String(seq).padStart(3, "0")}`,
      channel,
    },
    authorizations: [{ is_bot: false, user_id: SUB, team_id: opts.subscriberTeam ?? TEAM }],
  };
}

const skip = (channel: string, opts?: Parameters<typeof envelope>[1]) =>
  processSlackMentionEnvelope(envelope(channel, opts) as Parameters<typeof processSlackMentionEnvelope>[0]);

beforeEach(async () => {
  for (const key of FLAGS) saved.set(key, process.env[key]);
  for (const key of FLAGS) delete process.env[key];
  process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
  sent = [];
  audits = [];
  tickets = [];
  wakes = [];
  resetDemoChannelClassifyStore();
  resetDemoSkippedChannelWakes();
  resetChannelClassifyBudgetFallbackForTests();
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      tickets.push({ orgId: input.orgId, summary: String(input.summary ?? ""), metadata: input.metadata });
      return createApproval(input);
    },
  });
  setStuckNotifyDepsForTests({
    listChannels: async (orgId) => [inbox(orgId)],
    send: async (_channel, text) => {
      sent.push(text);
      return { ok: true };
    },
    audit: async (event) => {
      audits.push(event as (typeof audits)[number]);
    },
    mail: async () => ({ ok: true }),
  });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(WAKE_URL)) {
      wakes.push(JSON.parse(String(init?.body || "{}")));
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "not_authed" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const emp = getRuntimeEmployees().find((item) => item.id === EMP)!;
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: SUB }] as typeof emp.allowedAccounts;
  restoreEmp = () => {
    emp.allowedAccounts = previous;
  };
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
  await bindEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG, slackUserId: SUB, slackTeamId: TEAM, displayName: "稲盛", userToken: "xoxp-pathc-test" });
  await updateWakeWebhook(EMP, { orgId: ORG, url: WAKE_URL, secret: "pathc-wake-secret" });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setProposalDepsForTests(null);
  setStuckNotifyDepsForTests(null);
  await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG }).catch(() => undefined);
  await updateWakeWebhook(EMP, { orgId: ORG, url: null, secret: "" }).catch(() => undefined);
  restoreEmp?.();
  for (const key of FLAGS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const OTHER_ORG = "org_other_tenant_fixture";
const REWAKE = "PATHC_REWAKE_ON_CLASSIFY_ENABLED";

async function approveCard(orgId = ORG): Promise<ApprovalRequest> {
  expect(lastTicketIds.length).toBeGreaterThan(0);
  const id = lastTicketIds.at(-1)!;
  const approved = await resolveApprovalWithoutWorkflow(id, "approved", "fixture-human", orgId);
  return approved!;
}

async function fulfil(approval: ApprovalRequest) {
  const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
  return fulfillApprovedAdmin(approval);
}

/** A separately approved channels.classify ticket (manual, not from a proposal). */
async function manualApproved(orgId: string, channel: string, classification = "internal"): Promise<ApprovalRequest> {
  const created = await createApproval({
    orgId,
    employeeId: orgId === ORG ? EMP : "",
    credentialId: "",
    title: "fixture",
    purpose: "admin.channel",
    summary: "fixture",
    risk: "high",
    tool: "channels.classify",
    metadata: { approvalClass: "admin", adminTool: "channels.classify", adminMutation: { surface: "slack", externalId: channel, classification, mixed: false } },
  });
  return (await resolveApprovalWithoutWorkflow(created.approval.id, "approved", "fixture-human", orgId))!;
}

const rewakeAudits = () => getRuntimeAudit().filter((a) => a.action === "slack.user_token_channel_rewake");
let lastTicketIds: string[] = [];

beforeEach(() => {
  lastTicketIds = [];
  setProposalDepsForTests({
    notifyApproval: async () => true,
    hasApprover: async () => true,
    createApproval: async (input) => {
      tickets.push({ orgId: input.orgId, summary: String(input.summary ?? ""), metadata: input.metadata });
      const created = await createApproval(input);
      lastTicketIds.push(created.approval.id);
      return created;
    },
  });
});

describe("flag OFF: unchanged", () => {
  test("PATHC_REWAKE_ON_CLASSIFY_ENABLED OFF → nothing is recorded and approval wakes nobody", async () => {
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    await skip(channel);
    expect(listDemoSkippedChannelWakesForTests()).toEqual([]);
    const result = await fulfil(await approveCard());
    expect(result?.ok).toBe(true);
    expect(wakes).toEqual([]);
    expect(rewakeAudits().filter((a) => JSON.stringify(a).includes(channel))).toEqual([]);
  });
});

describe("flag ON: approved classification → the latest skipped mention is re-woken once", () => {
  test("skip, skip, approve the card → exactly one wake for the LATEST mention, no text; a second run wakes nobody", async () => {
    process.env[REWAKE] = "true";
    process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
    const channel = channelId();
    const first = envelope(channel);
    const second = envelope(channel);
    await processSlackMentionEnvelope(first as Parameters<typeof processSlackMentionEnvelope>[0]);
    await processSlackMentionEnvelope(second as Parameters<typeof processSlackMentionEnvelope>[0]);
    expect(wakes).toEqual([]);
    const records = listDemoSkippedChannelWakesForTests();
    expect(records.length).toBe(1);
    expect(records[0].eventTs).toBe(second.event.ts);
    expect(JSON.stringify(records)).not.toContain(SECRET_TEXT);

    const approval = await approveCard();
    expect((await fulfil(approval))?.ok).toBe(true);
    expect(wakes.length).toBe(1);
    const payload = wakes[0];
    expect(payload.channel).toBe(channel);
    expect(payload.ts).toBe(second.event.ts);
    expect(payload.employeeId).toBe(EMP);
    // 21:50: the wake carries the fixed instruction (channel + ts), never the body.
    expect(String(payload.text)).toContain("取りこぼしたメンション");
    expect(String(payload.text)).toContain("スレッドを読んで対応");
    expect(String(payload.text)).toContain(channel);
    expect(String(payload.text)).toContain(String(second.event.ts));
    expect((payload.rewake as Record<string, unknown>)?.instructionJa).toBe(payload.text);
    expect((payload.rewake as Record<string, unknown>)?.approvalId).toBe(approval.id);
    expect((payload.ingressHandoff as Record<string, unknown>)?.bodyMode).toBe("none");
    expect(JSON.stringify(payload)).not.toContain(SECRET_TEXT);
    const audits = rewakeAudits().filter((a) => JSON.stringify(a).includes(channel));
    expect(audits.length).toBe(1);
    expect(audits[0].orgId).toBe(ORG);
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);

    // Never twice: the same approval again, and a later approval of the same channel.
    await rewakeSkippedChannelWakesAfterApproval({ approval, surface: "slack", externalId: channel });
    await rewakeSkippedChannelWakesAfterApproval({ approval: await manualApproved(ORG, channel), surface: "slack", externalId: channel });
    expect(wakes.length).toBe(1);
  });

  test("concurrent approvals (same and different tickets) → exactly one wake", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    const a = await manualApproved(ORG, channel);
    const b = await manualApproved(ORG, channel);
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const runs = await Promise.all([
      ...Array.from({ length: 6 }, () => rewakeSkippedChannelWakesAfterApproval({ approval: a, surface: "slack", externalId: channel })),
      ...Array.from({ length: 6 }, () => rewakeSkippedChannelWakesAfterApproval({ approval: b, surface: "slack", externalId: channel })),
    ]);
    expect(wakes.length).toBe(1);
    expect(runs.reduce((n, r) => n + r.woke, 0)).toBe(1);
  });

  test("concurrent claims at the data layer → one winner", async () => {
    const channel = channelId();
    const approval = await manualApproved(ORG, channel);
    await recordSkippedChannelWake({ orgId: ORG, employeeId: EMP, channelId: channel, eventTs: "1788100001.000001", threadTs: null, eventId: "Ev0PCRACE1", speakerSlackUserId: SPEAKER, speakerTeamId: TEAM, subscriberSlackUserId: SUB, subscriberTeamId: TEAM });
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimSkippedChannelWakes({ orgId: ORG, channelId: channel, approvalId: approval.id, ttlSeconds: 86400 })));
    const won = claims.filter((c) => c.state === "ok" && c.rows.length === 1);
    expect(won.length).toBe(1);
  });
});

describe("BOLA / approval integrity", () => {
  test("another org's approval for the same channel id wakes nobody and leaves the record unclaimed", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    await upsertOrgChannel({ orgId: OTHER_ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const other = await manualApproved(OTHER_ORG, channel);
    const r = await rewakeSkippedChannelWakesAfterApproval({ approval: other, surface: "slack", externalId: channel });
    expect(r.woke).toBe(0);
    expect(wakes).toEqual([]);
    expect(listDemoSkippedChannelWakesForTests()[0].claimedAt).toBeNull();
    // The own org's approval still works afterwards.
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const own = await manualApproved(ORG, channel);
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: own, surface: "slack", externalId: channel })).woke).toBe(1);
  });

  test("a forged approval object (own id, other org / other org id, own org) wakes nobody", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    await upsertOrgChannel({ orgId: OTHER_ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const own = await manualApproved(ORG, channel);
    const other = await manualApproved(OTHER_ORG, channel);
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: { ...own, orgId: OTHER_ORG }, surface: "slack", externalId: channel })).woke).toBe(0);
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: { ...other, orgId: ORG }, surface: "slack", externalId: channel })).woke).toBe(0);
    expect(wakes).toEqual([]);
  });

  test("a pending (not approved) or rejected ticket wakes nobody (no self-approval shortcut)", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const created = await createApproval({ orgId: ORG, employeeId: EMP, credentialId: "", title: "f", purpose: "admin.channel", summary: "f", risk: "high", tool: "channels.classify" });
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: created.approval, surface: "slack", externalId: channel })).woke).toBe(0);
    // Claiming the status in the object is not enough: the stored ticket is re-read.
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: { ...created.approval, status: "approved" }, surface: "slack", externalId: channel })).woke).toBe(0);
    const rejected = await resolveApprovalWithoutWorkflow(created.approval.id, "rejected", "fixture-human", ORG);
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: rejected!, surface: "slack", externalId: channel })).woke).toBe(0);
    expect(wakes).toEqual([]);
    expect(await getApprovalById(created.approval.id, ORG)).toBeTruthy();
  });

  test("the record is per org: another org's skip is never claimed by this org", async () => {
    const channel = channelId();
    await recordSkippedChannelWake({ orgId: OTHER_ORG, employeeId: "emp_other", channelId: channel, eventTs: "1788100002.000002", threadTs: null, eventId: "Ev0PCOTHER", speakerSlackUserId: SPEAKER, speakerTeamId: TEAM, subscriberSlackUserId: SUB, subscriberTeamId: TEAM });
    const approval = await manualApproved(ORG, channel);
    const claim = await claimSkippedChannelWakes({ orgId: ORG, channelId: channel, approvalId: approval.id, ttlSeconds: 86400 });
    expect(claim.state === "ok" ? claim.rows : null).toEqual([]);
  });
});

describe("the approved class decides; stale / changed state is not re-woken", () => {
  test("approved as unknown → no wake and the record stays for a later real classification", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "unknown", skipInspect: true });
    const r = await rewakeSkippedChannelWakesAfterApproval({ approval: await manualApproved(ORG, channel, "unknown"), surface: "slack", externalId: channel });
    expect(r.woke).toBe(0);
    expect(r.state).toBe("class_disallows");
    expect(listDemoSkippedChannelWakesForTests()[0].claimedAt).toBeNull();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "shared_external", mixed: true, skipInspect: true });
    expect((await rewakeSkippedChannelWakesAfterApproval({ approval: await manualApproved(ORG, channel, "shared_external"), surface: "slack", externalId: channel })).woke).toBe(1);
  });

  test("older than the 24h window → not re-woken", async () => {
    const channel = channelId();
    const t0 = Date.now();
    await recordSkippedChannelWake({ orgId: ORG, employeeId: EMP, channelId: channel, eventTs: "1788100003.000003", threadTs: null, eventId: "Ev0PCSTALE", speakerSlackUserId: SPEAKER, speakerTeamId: TEAM, subscriberSlackUserId: SUB, subscriberTeamId: TEAM, nowMs: t0 });
    const approval = await manualApproved(ORG, channel);
    const claim = await claimSkippedChannelWakes({ orgId: ORG, channelId: channel, approvalId: approval.id, ttlSeconds: 86400, nowMs: t0 + 86_401_000 });
    expect(claim.state === "ok" ? claim.rows : null).toEqual([]);
  });

  test("subscriber unbound after the skip → claimed but not woken (audited, ids only)", async () => {
    process.env[REWAKE] = "1";
    const channel = channelId();
    await skip(channel);
    await revokeEmployeeSlackIdentity({ employeeId: EMP, orgId: ORG });
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channel, classification: "internal", skipInspect: true });
    const r = await rewakeSkippedChannelWakesAfterApproval({ approval: await manualApproved(ORG, channel), surface: "slack", externalId: channel });
    expect(r.woke).toBe(0);
    expect(wakes).toEqual([]);
    const skipped = getRuntimeAudit().filter((a) => a.action === "slack.user_token_channel_rewake_skipped" && JSON.stringify(a).includes(channel));
    expect(skipped.length).toBe(1);
    expect((skipped[0].metadata as Record<string, unknown>).reason).toBe("binding_changed");
  });

  test("data layer: an older out-of-order skip never replaces the latest; bad ids are denied", async () => {
    const channel = channelId();
    const base = { orgId: ORG, employeeId: EMP, channelId: channel, threadTs: null, speakerSlackUserId: SPEAKER, speakerTeamId: TEAM, subscriberSlackUserId: SUB, subscriberTeamId: TEAM };
    await recordSkippedChannelWake({ ...base, eventTs: "1788100010.000010", eventId: "Ev0PCNEW" });
    await recordSkippedChannelWake({ ...base, eventTs: "1788100005.000005", eventId: "Ev0PCOLD" });
    const rows = listDemoSkippedChannelWakesForTests().filter((r) => r.channelId === channel);
    expect(rows.map((r) => r.eventId)).toEqual(["Ev0PCNEW"]);
    expect((await recordSkippedChannelWake({ ...base, channelId: "D0NOTACHAN", eventTs: "1788100011.000011", eventId: "Ev0PCD" })).state).toBe("denied");
    expect((await recordSkippedChannelWake({ ...base, eventTs: "not-a-ts", eventId: "Ev0PCX" })).state).toBe("denied");
    expect((await recordSkippedChannelWake({ ...base, speakerSlackUserId: "<script>", eventTs: "1788100012.000012", eventId: "Ev0PCY" })).state).toBe("denied");
  });
});

describe("config-change-request path (P1_CONFIG_CHANGE_REQUEST_ENABLED) also re-wakes once", () => {
  test("employee-requested channel_classification approved by an owner → one wake; a repeat fulfil wakes nobody", async () => {
    process.env[REWAKE] = "1";
    const savedCc = process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED;
    process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED = "1";
    try {
      const channel = channelId();
      await skip(channel);
      const { createConfigChangeRequest, isPendingConfigChange } = await import("@/lib/config-change-request/service");
      const created = await createConfigChangeRequest(
        {
          orgId: ORG,
          employeeId: EMP,
          credentialId: null,
          args: { kind: "channel_classification", jobId: `job-pathc-${channel}`, requestedBy: { name: "稲盛" }, channel: { externalId: channel, classification: "internal" } },
        },
        { resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }), notify: async () => true }
      );
      expect(isPendingConfigChange(created)).toBe(true);
      const approvalId = (created as { approvalId: string }).approvalId;
      const { resolveApproval } = await import("@/lib/data/approvals");
      const { fulfillIfApproved } = await import("@/lib/approvals/fulfill");
      const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "user_owner" });
      expect(approved?.status).toBe("approved");
      await fulfillIfApproved(approved!, "approved");
      expect(wakes.length).toBe(1);
      expect(wakes[0].channel).toBe(channel);
      expect(String(wakes[0].text)).toContain("取りこぼしたメンション");
      await fulfillIfApproved(approved!, "approved");
      expect(wakes.length).toBe(1);
    } finally {
      if (savedCc === undefined) delete process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED;
      else process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED = savedCc;
    }
  });
});
