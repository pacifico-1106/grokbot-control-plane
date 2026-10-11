/**
 * #292 (木村 2026-10-11): for the same org × channel, `unregistered_channel_denied`
 * (a post denied) and `unclassified_channel_wake_skipped` (a mention that did
 * not wake the employee) used different dedup keys, so two notices could arrive
 * within the 6h window. They now share ONE key per org × channel: one notice per
 * 6h, saying which event happened; a second event inside the window is
 * suppressed and counted in the audit (ids only, no message body). The per-org
 * hourly cap still applies (the shared slot is taken first, so a suppressed
 * event never spends the cap).
 *
 * Demo mode, dummy ids, no network.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import { resetChannelClassifyBudgetFallbackForTests } from "@/lib/channel-classify/budget";
import { DENY_NOTICE_WINDOW_SECONDS, notifyChannelStuck, setStuckNotifyDepsForTests, type StuckNoticeKind } from "@/lib/channel-classify/stuck-notify";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

const ORG = DEMO_ORG.id;
const ORG_B = "org_shared_key_b";
const BODY = "SHARED-KEY-BODY-見積もりは来週-QWERTY";
const DENY: StuckNoticeKind = "unregistered_channel_denied";
const SKIP: StuckNoticeKind = "unclassified_channel_wake_skipped";

let sent: Array<{ orgId: string; text: string }> = [];
let audits: Array<{ orgId: string; action: string; summary?: string; metadata?: Record<string, unknown> }> = [];
let seq = 0;
let now = Date.UTC(2026, 9, 11, 3, 0, 0);

function inbox(orgId: string): NotificationChannelRuntime {
  return { id: `nc_${orgId}`, orgId, provider: "slack", label: "x", enabled: true, isDefault: true, config: {}, secrets: {} } as unknown as NotificationChannelRuntime;
}
function channel(): string {
  seq += 1;
  return `C0SK${String(seq).padStart(6, "0")}`;
}
function notify(kind: StuckNoticeKind, externalId: string, orgId = ORG) {
  return notifyChannelStuck({
    orgId,
    kind,
    ref: { surface: "slack", externalId },
    reason: kind === DENY ? "external_confidential_denied" : "channel_not_classified",
    approvalId: null,
    proposalState: "not_proposed",
    employee: { approvalChannelId: null },
  });
}
const sentTo = (orgId: string) => sent.filter((s) => s.orgId === orgId);
const noticeRows = (externalId: string, orgId = ORG) =>
  audits.filter((a) => a.orgId === orgId && a.action === "channel_stuck.notice" && a.metadata?.externalId === externalId);
const suppressedRows = (externalId: string, orgId = ORG) =>
  audits.filter((a) => a.orgId === orgId && a.action === "channel_stuck.notice_suppressed" && a.metadata?.externalId === externalId);

beforeEach(() => {
  process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
  delete process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR;
  sent = [];
  audits = [];
  now += 7 * 24 * 60 * 60 * 1000;
  setSystemTime(new Date(now));
  resetDemoChannelClassifyStore();
  resetChannelClassifyBudgetFallbackForTests();
  setStuckNotifyDepsForTests({
    listChannels: async (orgId) => [inbox(orgId)],
    send: async (ch, text) => {
      sent.push({ orgId: ch.orgId, text });
      return { ok: true };
    },
    audit: async (event) => {
      audits.push(event as (typeof audits)[number]);
    },
    mail: async () => ({ ok: true }),
  });
});

afterEach(() => {
  setSystemTime();
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  delete process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR;
  setStuckNotifyDepsForTests(null);
});

describe("one shared dedup key per org × channel (deny + wake skip)", () => {
  test("deny then wake skip within 6h → 1 notice; the second is suppressed and counted in the audit", async () => {
    const c = channel();
    expect((await notify(DENY, c)).status).toBe("sent_default");
    setSystemTime(new Date(now + 60 * 60 * 1000));
    expect((await notify(SKIP, c)).status).toBe("suppressed");
    expect(sentTo(ORG).length).toBe(1);
    expect(noticeRows(c).length).toBe(1);
    const rows = suppressedRows(c);
    expect(rows.length).toBe(1);
    expect(rows[0].metadata).toMatchObject({
      event: `channel_stuck.${SKIP}.suppressed`,
      kind: SKIP,
      surface: "slack",
      externalId: c,
      reason: "channel_not_classified",
      windowHours: 6,
    });
  });

  test("wake skip then deny within 6h → 1 notice (order does not matter)", async () => {
    const c = channel();
    expect((await notify(SKIP, c)).status).toBe("sent_default");
    expect((await notify(DENY, c)).status).toBe("suppressed");
    expect((await notify(DENY, c)).status).toBe("suppressed");
    expect(sentTo(ORG).length).toBe(1);
    expect(suppressedRows(c).map((r) => r.metadata?.kind)).toEqual([DENY, DENY]);
  });

  test("the notice says which event happened", async () => {
    const a = channel();
    const b = channel();
    await notify(DENY, a);
    await notify(SKIP, b);
    const [denyText, skipText] = sentTo(ORG).map((s) => s.text);
    expect(denyText).toContain(`イベント: ${DENY}`);
    expect(denyText).not.toContain(`イベント: ${SKIP}`);
    expect(skipText).toContain(`イベント: ${SKIP}`);
    expect(skipText).not.toContain(`イベント: ${DENY}`);
    for (const text of [denyText, skipText]) expect(text).toContain("6 時間");
  });

  test("after 6h → a new notice", async () => {
    const c = channel();
    await notify(DENY, c);
    expect((await notify(SKIP, c)).status).toBe("suppressed");
    setSystemTime(new Date(now + DENY_NOTICE_WINDOW_SECONDS * 1000 + 1000));
    expect((await notify(SKIP, c)).status).toBe("sent_default");
    expect(sentTo(ORG).length).toBe(2);
  });

  test("different channels → separate notices", async () => {
    const a = channel();
    const b = channel();
    expect((await notify(DENY, a)).status).toBe("sent_default");
    expect((await notify(SKIP, b)).status).toBe("sent_default");
    expect((await notify(DENY, b)).status).toBe("suppressed");
    expect(sentTo(ORG).length).toBe(2);
  });

  test("another org with the same channel id → independent (BOLA: never suppressed by, or audited into, the other org)", async () => {
    const c = channel();
    expect((await notify(DENY, c, ORG)).status).toBe("sent_default");
    expect((await notify(SKIP, c, ORG_B)).status).toBe("sent_default");
    expect((await notify(DENY, c, ORG_B)).status).toBe("suppressed");
    expect(sentTo(ORG).length).toBe(1);
    expect(sentTo(ORG_B).length).toBe(1);
    expect(suppressedRows(c, ORG)).toEqual([]);
    expect(suppressedRows(c, ORG_B).length).toBe(1);
  });

  test("ids only: no message body in notices or audit rows", async () => {
    const c = channel();
    await notify(DENY, c);
    await notify(SKIP, c);
    const all = JSON.stringify({ sent, audits });
    expect(all).not.toContain(BODY);
    for (const row of suppressedRows(c)) {
      expect(Object.keys(row.metadata ?? {}).sort()).toEqual(
        ["auditClass", "event", "externalId", "kind", "reason", "surface", "windowHours"].sort()
      );
    }
  });

  test("other kinds keep their own key (ledger_write_failed is not merged into the channel key)", async () => {
    const c = channel();
    await notify(DENY, c);
    const r = await notifyChannelStuck({ orgId: ORG, kind: "ledger_write_failed", ref: { surface: "slack", externalId: c }, reason: "x" });
    expect(r.status).toBe("sent_default");
  });
});

describe("per-org hourly cap still applies", () => {
  test("cap 1: first channel sent, second channel → cap summary; a suppressed same-channel event does not spend the cap", async () => {
    process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR = "1";
    const a = channel();
    const b = channel();
    const c2 = channel();
    expect((await notify(DENY, a)).status).toBe("sent_default");
    expect((await notify(SKIP, a)).status).toBe("suppressed");
    const second = await notify(SKIP, b);
    expect(second).toMatchObject({ status: "sent_default", summary: true });
    expect((await notify(DENY, c2)).status).toBe("rate_limited");
  });
});
