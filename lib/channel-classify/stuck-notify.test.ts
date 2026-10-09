/**
 * Stuck notifications (PR-B): a post denied in an unregistered channel, a
 * ledger / backfill failure, or an unset notifyMouth never stops silently.
 * Routing: employee's approval channel → org default approval channel → ops.
 * Rate-limited + deduped. No message body. Never throws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { notifyChannelStuck, setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { channelRefFromInvokeBody, egressDenyNextStep, onEgressDenied } from "@/lib/channel-classify/deny-hook";
import { setProposalDepsForTests } from "@/lib/channel-classify/proposals";
import { setChannelFactsDepsForTests } from "@/lib/channel-classify/facts";
import { upsertOrgChannel } from "@/lib/data/directory";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const ORG = DEMO_ORG.id;
type Sent = { channelId: string; provider: string; text: string };
let sent: Sent[] = [];
let audits: Array<{ orgId: string; action: string; metadata?: Record<string, unknown> }> = [];
let mails: Array<{ to: string[]; text: string }> = [];
let failing = new Set<string>();
let channels: NotificationChannelRuntime[] = [];

function inbox(id: string, provider: "slack" | "line" | "telegram", isDefault = false): NotificationChannelRuntime {
  return { id, orgId: ORG, provider, label: id, enabled: true, isDefault, config: {}, secrets: {} } as unknown as NotificationChannelRuntime;
}

beforeEach(() => {
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  sent = [];
  audits = [];
  mails = [];
  failing = new Set();
  channels = [inbox("nc_slack_default", "slack", true), inbox("nc_line_emp", "line"), inbox("nc_tg", "telegram")];
  resetDemoChannelClassifyStore();
  setStuckNotifyDepsForTests({
    listChannels: async (orgId) => channels.filter((c) => c.orgId === orgId),
    send: async (channel, text) => {
      if (failing.has(channel.id)) return { ok: false, error: "delivery_failed" };
      sent.push({ channelId: channel.id, provider: channel.provider, text });
      return { ok: true };
    },
    audit: async (event) => { audits.push(event); },
    mail: async (input) => { mails.push(input); return { ok: true }; },
  });
});

afterEach(() => {
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  delete process.env.PLATFORM_OPS_ORG_ID;
  delete process.env.APPROVAL_ALERT_OPS_EMAILS;
  setStuckNotifyDepsForTests(null);
  setProposalDepsForTests(null);
  setChannelFactsDepsForTests(null);
});

const SURFACES = [
  { surface: "slack" as const, externalId: "C0STUCK0001" },
  { surface: "line" as const, externalId: "Cstucklinegroup01" },
  { surface: "telegram" as const, externalId: "-1005550001" },
];

describe("stuck notification per channel (unregistered channel deny)", () => {
  for (const ref of SURFACES) {
    test(`${ref.surface}: approver gets channel, reason and the one-tap fix; no body`, async () => {
      const result = await notifyChannelStuck({
        orgId: ORG,
        kind: "unregistered_channel_denied",
        ref,
        reason: "external_confidential_denied",
        approvalId: "appr_fixture_1",
        employee: { approvalChannelId: "nc_line_emp" },
      });
      expect(result.status).toBe("sent_approver");
      expect(sent.length).toBe(1);
      expect(sent[0].channelId).toBe("nc_line_emp");
      expect(sent[0].text).toContain(ref.externalId);
      expect(sent[0].text).toContain("external_confidential_denied");
      expect(sent[0].text).toContain("appr_fixture_1");
      expect(/grok/i.test(sent[0].text)).toBe(false);
      expect(audits.some((a) => a.orgId === ORG && a.metadata?.event === "channel_stuck.unregistered_channel_denied")).toBe(true);
    });
  }
});

describe("routing fallback", () => {
  test("employee inbox fails → org default approval channel", async () => {
    failing.add("nc_line_emp");
    const result = await notifyChannelStuck({ orgId: ORG, kind: "unregistered_channel_denied", ref: SURFACES[0], reason: "external_confidential_denied", employee: { approvalChannelId: "nc_line_emp" } });
    expect(result.status).toBe("sent_default");
    expect(sent.map((s) => s.channelId)).toEqual(["nc_slack_default"]);
  });

  test("no approval channel at all → ops (audit mirror ids-only + ops email)", async () => {
    channels = [];
    process.env.PLATFORM_OPS_ORG_ID = "org_platform_ops";
    process.env.APPROVAL_ALERT_OPS_EMAILS = "ops@staffpass.example";
    const result = await notifyChannelStuck({ orgId: ORG, kind: "unregistered_channel_denied", ref: SURFACES[1], reason: "external_confidential_denied" });
    expect(result.status).toBe("sent_ops");
    const mirror = audits.find((a) => a.orgId === "org_platform_ops");
    expect(mirror?.metadata?.targetOrgId).toBe(ORG);
    expect(mails.length).toBe(1);
    expect(mails[0].text).toContain(SURFACES[1].externalId);
  });

  test("nothing reachable → undelivered, still audited in the tenant org", async () => {
    channels = [];
    const result = await notifyChannelStuck({ orgId: ORG, kind: "ledger_write_failed", ref: SURFACES[0], reason: "upsert_failed" });
    expect(result.status).toBe("undelivered");
    expect(audits.some((a) => a.orgId === ORG)).toBe(true);
  });

  test("another org's inbox is never used", async () => {
    channels = [{ ...inbox("nc_foreign", "slack", true), orgId: "org_foreign" } as NotificationChannelRuntime];
    const result = await notifyChannelStuck({ orgId: ORG, kind: "unregistered_channel_denied", ref: SURFACES[0], reason: "external_confidential_denied" });
    expect(sent.length).toBe(0);
    expect(result.status).not.toBe("sent_default");
  });
});

describe("rate limit, flag, never throws", () => {
  test("same org × kind × channel within the window → suppressed; another channel still sent", async () => {
    const input = { orgId: ORG, kind: "unregistered_channel_denied" as const, ref: SURFACES[0], reason: "external_confidential_denied" };
    expect((await notifyChannelStuck(input)).status).toBe("sent_default");
    expect((await notifyChannelStuck(input)).status).toBe("suppressed");
    expect((await notifyChannelStuck({ ...input, ref: SURFACES[2] })).status).toBe("sent_default");
    expect(sent.length).toBe(2);
  });

  test("flag OFF → nothing", async () => {
    delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
    expect((await notifyChannelStuck({ orgId: ORG, kind: "backfill_failed", reason: "x" })).status).toBe("flag_off");
    expect(sent.length).toBe(0);
  });

  test("a throwing sender never throws out", async () => {
    setStuckNotifyDepsForTests({
      listChannels: async () => channels,
      send: async () => { throw new Error("boom"); },
      audit: async () => { throw new Error("audit down"); },
      mail: async () => ({ ok: false }),
    });
    const result = await notifyChannelStuck({ orgId: ORG, kind: "unregistered_channel_denied", ref: SURFACES[0], reason: "external_confidential_denied" });
    expect(["undelivered", "error"]).toContain(result.status);
  });
});

describe("deny hook", () => {
  test("channel ref per surface from the invoke body", () => {
    expect(channelRefFromInvokeBody({ tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0X1" }, args: {} } as never)).toEqual({ surface: "slack", externalId: "C0X1" });
    expect(channelRefFromInvokeBody({ tool: "comm.send", conversation: { surface: "line", lineId: "Cgroup1" }, args: {} } as never)).toEqual({ surface: "line", externalId: "Cgroup1" });
    expect(channelRefFromInvokeBody({ tool: "comm.send", conversation: { surface: "telegram", telegramChatId: "-100777" }, args: {} } as never)).toEqual({ surface: "telegram", externalId: "-100777" });
    expect(channelRefFromInvokeBody({ tool: "mail.send", conversation: { surface: "mail", email: "a@example.com" }, args: {} } as never)).toBeNull();
  });

  for (const ref of SURFACES) {
    test(`${ref.surface}: external_confidential_denied in an unregistered channel → notice + proposal; body never sent`, async () => {
      process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
      setChannelFactsDepsForTests({ slackApi: async () => ({ ok: false, error: "not_in_channel" }), resolveToken: async () => "xoxb-fixture" });
      setProposalDepsForTests({ notifyApproval: async () => true });
      const conversation =
        ref.surface === "slack" ? { surface: "slack", slackChannelId: ref.externalId }
          : ref.surface === "line" ? { surface: "line", lineId: ref.externalId }
            : { surface: "telegram", telegramChatId: ref.externalId };
      await onEgressDenied({
        orgId: ORG,
        employee: { id: "emp_comm", approvalChannelId: null },
        body: { tool: "comm.reply", conversation, args: { text: "SECRET-BODY-DO-NOT-LEAK" } } as never,
        egress: { decision: "deny", reason: "external_confidential_denied" },
      });
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain(ref.externalId);
      expect(sent[0].text).not.toContain("SECRET-BODY-DO-NOT-LEAK");
      expect(sent[0].text).toMatch(/承認ID: \S+/);
    });
  }

  test("registered channel or another deny reason → no notice", async () => {
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0REGISTERED1", classification: "shared_external", mixed: true, skipInspect: true });
    await onEgressDenied({ orgId: ORG, employee: { id: "emp_comm" }, body: { tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0REGISTERED1" }, args: {} } as never, egress: { decision: "deny", reason: "external_confidential_denied" } });
    await onEgressDenied({ orgId: ORG, employee: { id: "emp_comm" }, body: { tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0UNREG00009" }, args: {} } as never, egress: { decision: "deny", reason: "internal_verbatim_unnamed" } });
    expect(sent.length).toBe(0);
  });

  test("notifier failure never throws out of the hook (the deny stays)", async () => {
    setStuckNotifyDepsForTests({ listChannels: async () => { throw new Error("db down"); }, send: async () => ({ ok: true }), audit: async () => undefined, mail: async () => ({ ok: true }) });
    await expect(onEgressDenied({ orgId: ORG, employee: { id: "emp_comm" }, body: { tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0UNREG00010" }, args: {} } as never, egress: { decision: "deny", reason: "external_confidential_denied" } })).resolves.toBeUndefined();
  });

  test("nextStep points to channels.classify with the channel id and an example call", async () => {
    const next = await egressDenyNextStep({ tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0UNREG00011" }, args: {} } as never, { decision: "deny", reason: "external_confidential_denied", audience: "unknown" }, ORG);
    expect(next?.tool).toBe("channels.classify");
    expect(next?.externalId).toBe("C0UNREG00011");
    expect(next?.example).toEqual({ name: "channels.classify", arguments: { surface: "slack", externalId: "C0UNREG00011", classification: "internal", mixed: false } });
    expect(next?.messageJa).toContain("C0UNREG00011");
    expect(await egressDenyNextStep({ tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C1" }, args: {} } as never, { decision: "deny", reason: "internal_verbatim_unnamed" }, ORG)).toBeNull();
  });
});
