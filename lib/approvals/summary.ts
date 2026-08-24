import type { ApprovalRequest } from "@/lib/types";

export type BuildApprovalSummaryInput = {
  tool: string;
  purpose: string;
  jobId: string;
  employeeDisplayName?: string | null;
  amountJpy?: number | null;
  risk: ApprovalRequest["risk"];
  extraLines?: string[];
};

/** Rich human-readable summary for tickets + poll responses. */
export function buildRichApprovalSummary(input: BuildApprovalSummaryInput): string {
  const lines: string[] = [];
  const who = input.employeeDisplayName?.trim() || "AI社員";
  lines.push(`${who} が「${input.tool}」の実行承認を求めています。`);
  lines.push(`目的: ${input.purpose}`);
  lines.push(`ジョブID: ${input.jobId}`);
  lines.push(`リスク: ${input.risk}`);
  if (input.amountJpy != null && Number.isFinite(input.amountJpy)) {
    lines.push(`金額: ¥${Math.round(input.amountJpy).toLocaleString("ja-JP")}`);
  }
  for (const extra of input.extraLines || []) {
    if (extra.trim()) lines.push(extra.trim());
  }
  lines.push("Staffpass 承認後にのみ confirm/send/order を完了できます。未承認のまま確定しないでください。");
  return lines.join("\n");
}

export function buildApprovalTitle(tool: string, purpose: string): string {
  return `承認依頼: ${tool}（${purpose}）`;
}

export function inferRiskForTool(tool: string): ApprovalRequest["risk"] {
  if (
    tool === "commerce.order" ||
    tool === "mail.send" ||
    tool === "calendar.confirm" ||
    tool === "browser.use"
  ) {
    return "high";
  }
  if (tool.includes("send") || tool.includes("confirm") || tool.includes("order")) {
    return "high";
  }
  if (tool.includes("quote") || tool.includes("draft") || tool.includes("propose")) {
    return "medium";
  }
  return "medium";
}
