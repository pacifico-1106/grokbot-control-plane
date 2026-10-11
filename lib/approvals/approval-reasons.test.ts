/**
 * approvalReasons[] (木村 2026-10-09 B, triage #3 / T1): every reason a request
 * went to approval, as structured data, plus the one card line every surface
 * renders. Pure functions; no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  APPROVAL_REASONS_CARD_MAX_CHARS,
  approvalReasonsCardLine,
  buildApprovalReasons,
  cardApprovalReasonsLine,
  readApprovalReasons,
} from "@/lib/approvals/approval-reasons";
import type { EgressVerdict } from "@/lib/types";

const FLAG = "APPROVAL_REASONS_ENABLED";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const confidentialEgress: EgressVerdict = {
  decision: "needs_approval",
  audience: "internal",
  effectiveAudience: "internal",
  informationClass: "confidential",
  fidelity: "source",
  namedRecipients: true,
  reason: "internal_confidential_source",
  messageJa: "機密情報の社内開示には上長の承認が必要です。",
};

describe("buildApprovalReasons: every reason, not just the first", () => {
  test("topic gate + egress + always_human (employee) + action limit are all returned, in a fixed order", () => {
    const reasons = buildApprovalReasons({
      topicGate: { requiresApproval: true, matchedTopics: ["支払", "金額"], reason: "sensitive_topic_requires_approval" },
      egress: confidentialEgress,
      employeeAlwaysHuman: true,
      toolAlwaysHuman: null,
      actionLimit: { decision: "needs_approval", reason: "action_limit_day_reached", message: "本日の実行上限（3件）に達したため、人の確認が必要です。", limit: { period: "day", value: 3, count: 3 } },
      spend: null,
      mailPolicyForceApproval: false,
      requestedInformationClass: "internal",
    });
    expect(reasons.map((r) => r.code)).toEqual(["topic_gate", "egress", "always_human", "action_limit"]);
    const topic = reasons[0] as Extract<(typeof reasons)[number], { code: "topic_gate" }>;
    expect(topic.topics).toEqual(["支払", "金額"]);
    const egress = reasons[1] as Extract<(typeof reasons)[number], { code: "egress" }>;
    expect(egress.reason).toBe("internal_confidential_source");
    expect(egress.informationClass).toBe("confidential");
    expect(egress.aiCannotLower).toBe(true);
    expect(egress.requestedInformationClass).toBe("internal");
    expect(egress.noteJa).toContain("下げられません");
    const human = reasons[2] as Extract<(typeof reasons)[number], { code: "always_human" }>;
    expect(human.source).toBe("employee_policy");
    const limit = reasons[3] as Extract<(typeof reasons)[number], { code: "action_limit" }>;
    expect(limit.limit).toEqual({ period: "day", value: 3, count: 3 });
    for (const r of reasons) expect(typeof r.messageJa).toBe("string");
  });

  test("tool-level always_human: explicit setting vs the tool's default (confirm / send / order)", () => {
    expect(buildApprovalReasons({ toolAlwaysHuman: "tool_setting" })).toMatchObject([
      { code: "always_human", source: "tool_setting" },
    ]);
    expect(buildApprovalReasons({ toolAlwaysHuman: "tool_default" })).toMatchObject([
      { code: "always_human", source: "tool_default" },
    ]);
    // employee-wide always_human wins the source label, never listed twice
    expect(buildApprovalReasons({ employeeAlwaysHuman: true, toolAlwaysHuman: "tool_default" }).length).toBe(1);
  });

  test("egress allow / summarize / deny and a topic gate that did not fire are not reasons", () => {
    expect(buildApprovalReasons({ egress: { ...confidentialEgress, decision: "allow" } })).toEqual([]);
    expect(buildApprovalReasons({ topicGate: { requiresApproval: false, matchedTopics: [], reason: "no_sensitive_topic" } })).toEqual([]);
    expect(buildApprovalReasons({ actionLimit: { decision: "allow", reason: "within_action_limit", message: "x" } })).toEqual([]);
  });

  test("spend and mail policy are reasons too", () => {
    const reasons = buildApprovalReasons({
      spend: { decision: "needs_approval", reason: "over_auto_limit", message: "上限を超えています" },
      mailPolicyForceApproval: true,
    });
    expect(reasons.map((r) => r.code)).toEqual(["spend", "mail_policy"]);
  });

  test("a requested class that is not lower is not echoed as 'requested'", () => {
    const [egress] = buildApprovalReasons({ egress: confidentialEgress, requestedInformationClass: "verbatim" });
    expect((egress as { requestedInformationClass?: string }).requestedInformationClass).toBeUndefined();
  });
});

describe("readApprovalReasons: strict reader for stored metadata", () => {
  test("round trip of what buildApprovalReasons wrote", () => {
    const reasons = buildApprovalReasons({ topicGate: { requiresApproval: true, matchedTopics: ["支払"], reason: "x" }, egress: confidentialEgress });
    expect(readApprovalReasons({ approvalReasons: JSON.parse(JSON.stringify(reasons)) })).toEqual(reasons);
  });
  test("unknown codes / wrong shapes / huge lists are dropped; nothing else from metadata leaks", () => {
    const read = readApprovalReasons({
      approvalReasons: [
        { code: "made_up", messageJa: "x" },
        { code: "topic_gate", topics: "支払" },
        { code: "topic_gate", topics: [1, "支払", { a: 1 }], scope: "any_channel", messageJa: "m", secret: "xoxb-leak" },
        ...Array.from({ length: 50 }, () => ({ code: "always_human", source: "employee_policy", messageJa: "m" })),
      ],
    });
    expect(read).not.toBeNull();
    expect(read!.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(read)).not.toContain("xoxb-leak");
    expect(read![0]).toMatchObject({ code: "topic_gate", topics: ["支払"] });
  });
  test("absent / not an array → null", () => {
    expect(readApprovalReasons({})).toBeNull();
    expect(readApprovalReasons(null)).toBeNull();
    expect(readApprovalReasons({ approvalReasons: "x" })).toBeNull();
  });
});

describe("card line", () => {
  test("one line naming every reason; bounded length even with many long topics", () => {
    const line = approvalReasonsCardLine(
      buildApprovalReasons({
        topicGate: { requiresApproval: true, matchedTopics: ["支払", "金額"], reason: "x" },
        egress: confidentialEgress,
        employeeAlwaysHuman: true,
        actionLimit: { decision: "needs_approval", reason: "action_limit_day_reached", message: "本日の実行上限（3件）に達したため、人の確認が必要です。" },
      })
    );
    expect(line.startsWith("承認が必要な理由:")).toBe(true);
    expect(line).toContain("機密話題（支払, 金額）");
    expect(line).toContain("confidential");
    expect(line).toContain("AIの指定では下げられません");
    expect(line).toContain("常に人の承認");
    expect(line).toContain("行為上限");
    const long = approvalReasonsCardLine(
      buildApprovalReasons({ topicGate: { requiresApproval: true, matchedTopics: Array.from({ length: 40 }, (_, i) => `とても長い機密話題その${i}`.repeat(4)), reason: "x" } })
    );
    expect(Array.from(long).length).toBeLessThanOrEqual(APPROVAL_REASONS_CARD_MAX_CHARS);
  });
  test("flag OFF → no card line even when metadata has reasons", () => {
    const metadata = { approvalReasons: buildApprovalReasons({ employeeAlwaysHuman: true }) };
    expect(cardApprovalReasonsLine(metadata)).toContain("承認が必要な理由");
    delete process.env[FLAG];
    expect(cardApprovalReasonsLine(metadata)).toBeNull();
  });
  test("no reasons → null", () => {
    expect(cardApprovalReasonsLine({ approvalReasons: [] })).toBeNull();
    expect(cardApprovalReasonsLine({})).toBeNull();
  });
});
