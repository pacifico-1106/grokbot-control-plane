/**
 * 2026-10-04 (木村 decision 3): what an approved conversation re-run reports.
 * The re-run never posts request text; it reports what fulfillment of the
 * APPROVED snapshot did. A Slack "stub" record means nothing was sent: fine in
 * demo mode, but in production (legacy records from before the fail-closed
 * change) it is reported as slack_token_missing instead of a fake ok.
 */
import { describe, expect, test } from "bun:test";
import { approvedRerunConversationDelivery } from "@/lib/approvals/approved-rerun-delivery";

const at = "2026-10-04T00:00:00.000Z";

describe("approvedRerunConversationDelivery", () => {
  test("slack fulfillment → the recorded Slack delivery (no new post)", () => {
    expect(approvedRerunConversationDelivery({ ok: true, delivery: "slack", channel: "C1", ts: "1.2", at }, { demo: false }))
      .toEqual({ ok: true, delivery: { ok: true, delivery: "slack", channel: "C1", ts: "1.2" } });
  });

  test("mail fulfillment → the recorded mail delivery", () => {
    expect(approvedRerunConversationDelivery({ ok: true, delivery: "mail", at }, { demo: false }))
      .toEqual({ ok: true, delivery: { ok: true, delivery: "mail" } });
  });

  test("stub in demo mode → stub delivery (still never the request text)", () => {
    expect(approvedRerunConversationDelivery({ ok: true, delivery: "stub", at }, { demo: true }))
      .toEqual({ ok: true, delivery: { ok: true, delivery: "stub" } });
  });

  test("stub in production (legacy record: nothing was sent) → slack_token_missing, not ok", () => {
    const result = approvedRerunConversationDelivery({ ok: true, delivery: "stub", at }, { demo: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("slack_token_missing");
      expect(result.messageJa).toContain("送信されていません");
    }
  });

  test("ok without a delivery kind in production → fail closed", () => {
    const result = approvedRerunConversationDelivery({ ok: true, at }, { demo: false });
    expect(result.ok).toBe(false);
  });

  test("failed fulfillment → its error code", () => {
    expect(approvedRerunConversationDelivery({ ok: false, error: "slack_token_missing", at }, { demo: false }))
      .toMatchObject({ ok: false, code: "slack_token_missing" });
  });
});
