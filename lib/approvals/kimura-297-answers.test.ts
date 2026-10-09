/**
 * 木村's answers on #297 (2026-10-09 22:31):
 *  2. reinvoke_with_approvalId WITHOUT reinvokeReason → a reason code
 *     (pending_attachment / not_executed_yet / admin_result_required) and the
 *     guidance 「同じ approvalId と同じ内容で、一度だけ」 (APPROVAL_REASONS_ENABLED;
 *     flag OFF → exactly the old shape). Docs + MCP description say the same.
 *  3. Admin / system cards (admin MCP tickets, channel-classification system
 *     proposals, AI config-change requests) get the reasons line too — within
 *     #275's 400-char card limit (summary + line); does not fit → no line.
 * (Answer 1 is pinned in lib/gateway/invoke-comm-send-internal-default.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { approvalPollFields } from "@/lib/approvals/poll-hint";
import { cardApprovalReasonsLine } from "@/lib/approvals/approval-reasons";
import { publicApproval } from "@/lib/approvals/public";
import { buildApprovalTelegramMessage } from "@/lib/notify/telegram";
import { listStaffpassMcpTools } from "@/lib/mcp/tools";
import type { ApprovalRequest } from "@/lib/types";

const FLAG = "APPROVAL_REASONS_ENABLED";
const ONCE = "同じ approvalId と同じ内容で、一度だけ";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const poll = (fulfillmentResult: Record<string, unknown> | null, adminResultRequired = false) =>
  approvalPollFields({ status: "approved", approvalId: "apr_1", fulfillmentResult, adminResultRequired }) as Record<string, unknown>;

describe("2. reinvoke without reinvokeReason: code + 「一度だけ」 guidance", () => {
  test("attachment not sent → pending_attachment", () => {
    const r = poll({ fileUpload: { status: "not_sent" } });
    expect(r.pollHint).toBe("reinvoke_with_approvalId");
    expect(r.reinvokeReason).toBeUndefined();
    expect(r.reinvokeCode).toBe("pending_attachment");
    expect(String(r.reinvokeGuidanceJa)).toContain(ONCE);
  });
  test("reconcile found the file never shared → pending_attachment", () => {
    expect(poll({ fileUpload: { status: "failed", code: "reconcile_not_found" } }).reinvokeCode).toBe("pending_attachment");
  });
  test("approved but not executed by Staffpass (no fulfillment result) → not_executed_yet", () => {
    const r = poll(null);
    expect(r.reinvokeCode).toBe("not_executed_yet");
    expect(String(r.reinvokeGuidanceJa)).toContain(ONCE);
  });
  test("admin result required → admin_result_required (admin MCP named)", () => {
    const r = poll({ ok: true }, true);
    expect(r.reinvokeCode).toBe("admin_result_required");
    expect(String(r.reinvokeGuidanceJa)).toContain(ONCE);
    expect(String(r.reinvokeGuidanceJa)).toContain("/api/mcp/admin");
  });
  test("definite Slack failure keeps reinvokeReason and gets no extra code", () => {
    const r = poll({ fileUpload: { status: "failed", slackError: "not_in_channel" } });
    expect(r.reinvokeReason).toBeTruthy();
    expect(r.reinvokeCode).toBeUndefined();
  });
  test("fulfilled / pending → no code", () => {
    expect(poll({ ok: true }).reinvokeCode).toBeUndefined();
    const pending = approvalPollFields({ status: "pending", approvalId: "a", fulfillmentResult: null, adminResultRequired: false }) as Record<string, unknown>;
    expect(pending.reinvokeCode).toBeUndefined();
  });
  test("flag OFF → exactly the old shape", () => {
    delete process.env[FLAG];
    expect(poll({ fileUpload: { status: "not_sent" } })).toEqual({ pollHint: "reinvoke_with_approvalId" });
    expect(poll(null)).toEqual({ pollHint: "reinvoke_with_approvalId" });
  });
  test("docs/mcp.md and the status tool description say 「一度だけ」 and name the code", () => {
    const doc = readFileSync("docs/mcp.md", "utf8");
    expect(doc).toContain(ONCE);
    expect(doc).toContain("pending_attachment");
    const status = listStaffpassMcpTools().find((t) => t.name === "staffpass_get_approval_status")!;
    expect(status.description).toContain("reinvokeCode");
    expect(status.description).toContain("exactly once");
  });
});

function approval(summary: string, metadata: Record<string, unknown>, tool = "channels.classify"): ApprovalRequest {
  return {
    id: "apr_admin_card_1", orgId: "org_x", employeeId: "", credentialId: "", title: "t", purpose: "admin.channel",
    summary, risk: "high", tool, status: "pending", jobId: "j", telegramRef: "ref1", statusToken: "s", pollPath: "/p",
    metadata, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as ApprovalRequest;
}
const SYSTEM_META = {
  approvalClass: "admin", always_human: true, isAdminMcpTool: true, adminTool: "channels.classify",
  proposalRequester: { kind: "system", source: "slack_member_joined" },
};
const ADMIN_META = { approvalClass: "admin", always_human: true, isAdminMcpTool: true, adminTool: "parties.upsert", adminRequester: { kind: "admin_agent" } };
const CONFIG_META = {
  approvalClass: "business", always_human: true,
  configChange: { kind: "instructions", requestedBy: "emp_1" },
};

describe("3. admin / system cards carry the reasons line within 400 chars", () => {
  test("system channel-classification proposal → line (always human, automatic proposal)", () => {
    const line = cardApprovalReasonsLine(SYSTEM_META, "【自動提案・未反映】参加チャネルの分類 C0ABC");
    expect(line).toContain("承認が必要な理由");
    expect(line).toContain("常に人の承認");
    expect(line).toContain("自動提案");
  });
  test("admin MCP ticket → line", () => {
    expect(cardApprovalReasonsLine(ADMIN_META, "管理エージェントからの変更依頼")).toContain("管理");
  });
  test("AI config-change request → line", () => {
    expect(cardApprovalReasonsLine(CONFIG_META, "設定変更の依頼")).toContain("設定変更");
  });
  test("summary + line stays ≤ 400; a summary that leaves no room → no line", () => {
    const short = "あ".repeat(100);
    const line = cardApprovalReasonsLine(SYSTEM_META, short)!;
    expect(Array.from(short).length + 1 + Array.from(line).length).toBeLessThanOrEqual(400);
    expect(cardApprovalReasonsLine(SYSTEM_META, "あ".repeat(380))).toBeNull();
    expect(cardApprovalReasonsLine(SYSTEM_META, "あ".repeat(400))).toBeNull();
  });
  test("surfaces: Web cardReasons + Telegram show it for an admin ticket; long summary → none", () => {
    const a = approval("【自動提案・未反映】参加チャネルの分類 C0ABC", SYSTEM_META);
    expect(publicApproval(a).cardReasons).toContain("承認が必要な理由");
    expect(buildApprovalTelegramMessage(a, null)).toContain("承認が必要な理由");
    const long = approval("あ".repeat(395), SYSTEM_META);
    expect(publicApproval(long).cardReasons).toBeNull();
    expect(buildApprovalTelegramMessage(long, null)).not.toContain("承認が必要な理由");
  });
  test("an ordinary employee ticket without stored reasons → no line (nothing invented)", () => {
    expect(cardApprovalReasonsLine({ approvalClass: "business" }, "x")).toBeNull();
  });
  test("flag OFF → no line on admin / system cards", () => {
    delete process.env[FLAG];
    expect(cardApprovalReasonsLine(SYSTEM_META, "x")).toBeNull();
    expect(publicApproval(approval("x", ADMIN_META)).cardReasons).toBeNull();
  });
});
