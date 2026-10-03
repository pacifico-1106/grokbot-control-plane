import { describe, expect, test } from "bun:test";
import {
  evaluateConfigChangeRequester,
  verifyConfigChangeRequester,
  type WakeRecord,
} from "@/lib/config-change-request/requester-verify";
import {
  buildApproverMessageJa,
  buildRequesterNoticeJa,
  requesterNameForNoticeJa,
} from "@/lib/config-change-request/core";

const NOW = Date.parse("2026-10-03T09:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const wake = (over: Partial<WakeRecord> = {}): WakeRecord => ({
  channel: "C_REQ", ts: "1700000000.0001", threadTs: null, speakerId: "U0TANAKA", createdAt: ago(60_000), ...over,
});
const requester = (slackUserId: string | null, name: string | null = "田中") => ({ name, slackUserId, email: null });
const conv = (over: Record<string, string | null> = {}) => ({
  surface: "slack", slackChannelId: "C_REQ", threadTs: "1700000000.0001", ...over,
});

describe("evaluateConfigChangeRequester (pure)", () => {
  test("declared Slack user spoke in that thread → verified", () => {
    const v = evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA"), conversation: conv(), wakes: [wake()], now: NOW });
    expect(v.status).toBe("verified");
    expect(v.observedSpeakerIds).toEqual(["U0TANAKA"]);
  });
  test("thread reply (thread_ts) also counts; comparison is exact (case-normalized only)", () => {
    const v = evaluateConfigChangeRequester({
      requestedBy: requester("u0tanaka"), conversation: conv(),
      wakes: [wake({ ts: "1700000000.0099", threadTs: "1700000000.0001" })], now: NOW,
    });
    expect(v.status).toBe("verified");
    const prefix = evaluateConfigChangeRequester({ requestedBy: requester("U0TANAK"), conversation: conv(), wakes: [wake()], now: NOW });
    expect(prefix.status).toBe("mismatch");
  });
  test("someone else spoke → mismatch, with the real speaker", () => {
    const v = evaluateConfigChangeRequester({
      requestedBy: requester("U0TANAKA", "社長"), conversation: conv(), wakes: [wake({ speakerId: "U0SATO" })], now: NOW,
    });
    expect(v.status).toBe("mismatch");
    expect(v.observedSpeakerIds).toEqual(["U0SATO"]);
  });
  test("other channel / other thread / too old / no speaker recorded → unverified", () => {
    for (const w of [
      wake({ channel: "C_OTHER" }),
      wake({ ts: "1700000000.0500" }),
      wake({ createdAt: ago(25 * 3600_000) }),
      wake({ speakerId: null }),
    ]) {
      const v = evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA"), conversation: conv(), wakes: [w], now: NOW });
      expect(v.status).toBe("unverified");
      expect(v.reason).toBe("no_wake_record");
    }
  });
  test("no thread given → only wakes in the channel within 30 minutes", () => {
    const recent = evaluateConfigChangeRequester({
      requestedBy: requester("U0TANAKA"), conversation: conv({ threadTs: null }), wakes: [wake({ createdAt: ago(10 * 60_000) })], now: NOW,
    });
    expect(recent.status).toBe("verified");
    const old = evaluateConfigChangeRequester({
      requestedBy: requester("U0TANAKA"), conversation: conv({ threadTs: null }), wakes: [wake({ createdAt: ago(45 * 60_000) })], now: NOW,
    });
    expect(old.status).toBe("unverified");
  });
  test("no declared Slack user → unverified but the observed speaker is kept", () => {
    const v = evaluateConfigChangeRequester({ requestedBy: requester(null), conversation: conv(), wakes: [wake()], now: NOW });
    expect(v.status).toBe("unverified");
    expect(v.reason).toBe("no_declared_slack_user");
    expect(v.observedSpeakerIds).toEqual(["U0TANAKA"]);
  });
  test("no conversation / non-Slack surface (LINE) → unverified", () => {
    expect(evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA"), conversation: null, wakes: [wake()], now: NOW }).reason).toBe("no_conversation");
    expect(
      evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA"), conversation: conv({ surface: "line" }), wakes: [wake()], now: NOW }).reason
    ).toBe("surface_not_supported");
  });
});

describe("verifyConfigChangeRequester (I/O)", () => {
  test("reads wakes for this org + employee only and maps audit metadata", async () => {
    const seen: Array<{ orgId: string; employeeId: string }> = [];
    const v = await verifyConfigChangeRequester(
      { orgId: "org_a", employeeId: "emp_a", requestedBy: requester("U0TANAKA"), conversation: conv(), now: NOW },
      {
        listWakes: async (orgId, employeeId) => {
          seen.push({ orgId, employeeId });
          return [{ metadata: { reason: "woke", channel: "C_REQ", ts: "1700000000.0001", thread_ts: null, speakerId: "U0TANAKA" }, createdAt: ago(1000) }];
        },
      }
    );
    expect(seen).toEqual([{ orgId: "org_a", employeeId: "emp_a" }]);
    expect(v.status).toBe("verified");
  });
  test("non-woke audits (wake_failed) are ignored", async () => {
    const v = await verifyConfigChangeRequester(
      { orgId: "o", employeeId: "e", requestedBy: requester("U0TANAKA"), conversation: conv(), now: NOW },
      { listWakes: async () => [{ metadata: { reason: "wake_failed", channel: "C_REQ", ts: "1700000000.0001", speakerId: "U0TANAKA" }, createdAt: ago(1000) }] }
    );
    expect(v.status).toBe("unverified");
  });
  test("lookup failure → unverified (fail-closed), never verified", async () => {
    const failing = await verifyConfigChangeRequester(
      { orgId: "o", employeeId: "e", requestedBy: requester("U0TANAKA"), conversation: conv(), now: NOW },
      { listWakes: async () => null }
    );
    expect(failing.status).toBe("unverified");
    expect(failing.reason).toBe("lookup_failed");
    const throwing = await verifyConfigChangeRequester(
      { orgId: "o", employeeId: "e", requestedBy: requester("U0TANAKA"), conversation: conv(), now: NOW },
      { listWakes: async () => { throw new Error("db down"); } }
    );
    expect(throwing.reason).toBe("lookup_failed");
  });
});

describe("copy uses the declared name only when verified", () => {
  const base = { employeeDisplayName: "営業AI", diffSummaryJa: "Instructions に追記", reason: null };
  test("verified → 〇〇さん + confirmation line", () => {
    const v = evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA"), conversation: conv(), wakes: [wake()], now: NOW });
    const msg = buildApproverMessageJa({ ...base, requester: requester("U0TANAKA"), verification: v });
    expect(msg.startsWith("田中さんから次の変更依頼が来ています: ")).toBe(true);
    expect(msg).toContain("Slack の発言者（U0TANAKA）と一致");
    expect(requesterNameForNoticeJa(requester("U0TANAKA"), v)).toBe("田中");
  });
  test("mismatch → no declared name in the headline, warning with the real speaker", () => {
    const v = evaluateConfigChangeRequester({ requestedBy: requester("U0TANAKA", "社長"), conversation: conv(), wakes: [wake({ speakerId: "U0SATO" })], now: NOW });
    const msg = buildApproverMessageJa({ ...base, requester: requester("U0TANAKA", "社長"), verification: v });
    expect(msg.startsWith("社長さんから")).toBe(false);
    expect(msg).toContain("⚠");
    expect(msg).toContain("U0SATO");
    expect(msg).toContain("反映しますか？");
    const notice = buildRequesterNoticeJa({ requester: requester("U0TANAKA", "社長"), verification: v, diffSummaryJa: "x", outcome: "rejected" });
    expect(notice.startsWith("ご依頼者さん")).toBe(true);
    expect(notice).not.toContain("社長");
  });
  test("unverified → marked 未確認; injected text in the name is not trusted", () => {
    const v = evaluateConfigChangeRequester({ requestedBy: requester(null, "代表取締役"), conversation: null, wakes: [], now: NOW });
    const msg = buildApproverMessageJa({ ...base, requester: requester(null, "代表取締役"), verification: v });
    expect(msg.startsWith("代表取締役さんから")).toBe(false);
    expect(msg).toContain("未確認");
    expect(requesterNameForNoticeJa(requester(null, "代表取締役"), v)).toBe("ご依頼者");
  });
  test("no verification argument (legacy pure call) keeps the old copy", () => {
    const msg = buildApproverMessageJa({ ...base, requester: requester(null) });
    expect(msg.startsWith("田中さんから次の変更依頼が来ています: ")).toBe(true);
  });
});
