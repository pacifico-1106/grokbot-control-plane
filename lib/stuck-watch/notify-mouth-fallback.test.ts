/**
 * notifyMouth unset / missing → with CHANNEL_STUCK_NOTIFY_ENABLED the alert
 * falls back to the org's approval channel, then ops (rate-limited). OFF →
 * unchanged (skipped notify_mouth_unset).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { notifyStuckWatchMouth } from "@/lib/stuck-watch/notify-mouth";
import { setStuckNotifyDepsForTests } from "@/lib/channel-classify/stuck-notify";
import { resetDemoChannelClassifyStore } from "@/lib/data/channel-classify";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";
import type { OrgStuckWatchPolicy } from "@/lib/types";

const sent: string[] = [];
const policy = { notifyMouth: "" } as unknown as OrgStuckWatchPolicy;

beforeEach(() => {
  sent.length = 0;
  resetDemoChannelClassifyStore();
  setStuckNotifyDepsForTests({
    listChannels: async () => [{ id: "nc_default", orgId: DEMO_ORG.id, provider: "slack", isDefault: true, enabled: true, config: {}, secrets: {} } as unknown as NotificationChannelRuntime],
    send: async (_channel, text) => { sent.push(text); return { ok: true }; },
    audit: async () => undefined,
    mail: async () => ({ ok: true }),
  });
});

afterEach(() => {
  delete process.env.CHANNEL_STUCK_NOTIFY_ENABLED;
  setStuckNotifyDepsForTests(null);
});

describe("notifyMouth fallback", () => {
  test("flag OFF → unchanged skip", async () => {
    const result = await notifyStuckWatchMouth(DEMO_ORG.id, policy, "⚠️ W4", { kind: "w4_config_drift", code: "egress_denied" });
    expect(result).toEqual({ ok: true, skipped: true, reason: "notify_mouth_unset" });
    expect(sent.length).toBe(0);
  });

  test("flag ON → delivered to the org default approval channel, then rate-limited", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    const first = await notifyStuckWatchMouth(DEMO_ORG.id, policy, "⚠️ W4 config_drift", { kind: "w4_config_drift", code: "egress_denied", tool: "comm.reply" });
    expect(first.ok).toBe(true);
    expect(first.skipped).not.toBe(true);
    expect(first.reason).toBe("notify_mouth_fallback");
    expect(first.channelId).toBe("nc_default");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("W4 config_drift");
    const second = await notifyStuckWatchMouth(DEMO_ORG.id, policy, "⚠️ W4 config_drift", { kind: "w4_config_drift", code: "egress_denied", tool: "comm.reply" });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("notify_mouth_fallback_suppressed");
    expect(sent.length).toBe(1);
  });

  test("flag ON + configured mouth missing → fallback as well", async () => {
    process.env.CHANNEL_STUCK_NOTIFY_ENABLED = "true";
    const result = await notifyStuckWatchMouth(DEMO_ORG.id, { notifyMouth: "nc_deleted" } as unknown as OrgStuckWatchPolicy, "⚠️ W1", { kind: "w1_mention_unanswered", code: "x", itemId: "i1" });
    expect(result.reason).toBe("notify_mouth_fallback");
    expect(sent.length).toBe(1);
  });
});
