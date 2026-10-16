import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import {
  buildPeerWakeCapNoticeJa,
  notifyPeerWakeCap,
  PEER_WAKE_STOP_SLACK_ACTION_ID,
  setPeerWakeNoticeDepsForTests,
} from "@/lib/notify/ai-peer-wake-notice";

const saved = process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;

beforeEach(() => {
  delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  setPeerWakeNoticeDepsForTests(null);
});

afterEach(() => {
  setPeerWakeNoticeDepsForTests(null);
  if (saved === undefined) delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  else process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = saved;
});

describe("AI peer-wake cap notice", () => {
  test("flag OFF: nothing sent", async () => {
    let sent = 0;
    setPeerWakeNoticeDepsForTests({
      listChannels: async () => [{ id: "ch1", orgId: DEMO_ORG.id, provider: "slack", enabled: true, isDefault: true } as never],
      sendSlack: async () => {
        sent += 1;
        return { ok: true };
      },
    });
    const r = await notifyPeerWakeCap({
      orgId: DEMO_ORG.id,
      speakerEmployeeId: "emp_comm",
      targetEmployeeId: "emp_sns",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventId: "Ev1",
      stopRef: "0123456789abcdef",
      count: 4,
      cap: 4,
    });
    expect(r.status).toBe("flag_off");
    expect(sent).toBe(0);
  });

  test("flag ON: Slack notice includes the stop button; audit is written; no message body", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const sent: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];
    setPeerWakeNoticeDepsForTests({
      listChannels: async () => [{ id: "ch1", orgId: DEMO_ORG.id, provider: "slack", enabled: true, isDefault: true } as never],
      sendSlack: async (_c, text, blocks) => {
        sent.push({ text, blocks });
        return { ok: true };
      },
    });
    const input = {
      orgId: DEMO_ORG.id,
      speakerEmployeeId: "emp_comm",
      targetEmployeeId: "emp_sns",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventId: "Ev1",
      stopRef: "0123456789abcdef",
      count: 4,
      cap: 4,
    };
    const r = await notifyPeerWakeCap(input);
    expect(r.status).toBe("sent_approver");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("上限");
    expect(sent[0].text).not.toContain("hello");
    const actions = sent[0].blocks.find((b) => b.type === "actions") as { elements?: Array<{ action_id?: string; value?: string }> };
    expect(actions.elements?.some((el) => el.action_id === PEER_WAKE_STOP_SLACK_ACTION_ID && el.value === "0123456789abcdef")).toBe(true);
    expect(buildPeerWakeCapNoticeJa(input)).toContain("C_CLOUD");
    expect(getRuntimeAudit().some((e) => e.action === "slack.peer_wake.cap_notified")).toBe(true);
  });
});
