import { describe, expect, test } from "bun:test";
import { isMentionWakeAudit } from "@/lib/data/audit";
import { evaluateW1Eligibility } from "@/lib/stuck-watch/w1-mention-unanswered";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import { DEMO_ORG } from "@/lib/demo-data";
import type { AuditEvent } from "@/lib/types";
import { MCP_HANDOFF_WAKE_ACTIONS } from "@/lib/mcp/endpoint-handoff";

function wake(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "aud_inbound_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_comm",
    credentialId: null,
    action: "inbound_notice.wake",
    purpose: "inbound_notice",
    summary: "受電通知で AI 社員を起こした",
    metadata: {
      reason: "woke",
      channel: "C_DUMMY",
      ts: "1000000000.000001",
      eventId: "Ev_dummy",
      phoneLast4: "1111",
    },
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    ...over,
  };
}

describe("inbound notice W1", () => {
  test("inbound_notice.wake (woke) is a mention-wake for stuck-watch", () => {
    expect(isMentionWakeAudit(wake())).toBe(true);
    expect(isMentionWakeAudit(wake({ metadata: { reason: "sales_skipped" } }))).toBe(false);
  });

  test("W1 eligibility uses the same mentionUnansweredMinutes window", () => {
    const policy = { ...defaultStuckWatchPolicy(), mentionUnansweredMinutes: 10 };
    const result = evaluateW1Eligibility({
      wake: wake(),
      policy,
      audits: [],
      approvals: [],
      now: new Date(),
      resolvedItemIds: new Set(),
      notifiedItemIds: new Set(),
    });
    expect(result.eligible).toBe(true);
    expect(result.itemId).toBe("w1:C_DUMMY:1000000000.000001");
  });

  test("MCP handoff wake actions include inbound_notice.wake", () => {
    expect(MCP_HANDOFF_WAKE_ACTIONS).toContain("inbound_notice.wake");
  });
});
