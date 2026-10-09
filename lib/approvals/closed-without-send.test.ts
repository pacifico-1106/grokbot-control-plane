/**
 * Approver-facing wording for an approval closed without sending (web result
 * page / status API). 木村 #286 decision 2: a thread that moved on is shown as
 * "not sent because it went stale".
 */
import { describe, expect, test } from "bun:test";
import { closedWithoutSendInfo } from "@/lib/approvals/closed-without-send";

describe("closedWithoutSendInfo", () => {
  test("thread_moved_on → stale wording (not sent)", () => {
    const info = closedWithoutSendInfo({ closedWithoutSend: { status: "superseded", reason: "thread_moved_on", at: "x" } });
    expect(info?.reason).toBe("thread_moved_on");
    expect(info?.messageJa).toMatch(/送信していません/);
    expect(info?.messageJa).toMatch(/スレッド/);
  });
  test("existing dedup reasons keep a not-sent wording; unknown reason → generic; nothing recorded → null", () => {
    expect(closedWithoutSendInfo({ closedWithoutSend: { reason: "newer_reply_sent" } })?.messageJa).toMatch(/送信していません/);
    expect(closedWithoutSendInfo({ closedWithoutSend: { reason: "approval_ttl_elapsed" } })?.messageJa).toMatch(/送信していません/);
    expect(closedWithoutSendInfo({ closedWithoutSend: { reason: "<b>x</b>" } })?.messageJa).toMatch(/送信していません/);
    expect(closedWithoutSendInfo({ closedWithoutSend: { reason: "<b>x</b>" } })?.messageJa).not.toContain("<b>");
    expect(closedWithoutSendInfo({})).toBeNull();
    expect(closedWithoutSendInfo(null)).toBeNull();
  });
});
