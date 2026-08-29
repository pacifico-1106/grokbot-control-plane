import { outboundConversationText } from "@/lib/employees/voice";
import { resolveConversationThreadId } from "@/lib/gateway/audience";
import type {
  ApprovalRequest,
  ConversationContext,
  EgressVerdict,
  GatewayInvokeRequest,
} from "@/lib/types";

export type BuildApprovalSummaryInput = {
  tool: string;
  purpose: string;
  jobId: string;
  employeeDisplayName?: string | null;
  amountJpy?: number | null;
  risk: ApprovalRequest["risk"];
  extraLines?: string[];
};

/** Structured artifact stored on approval.metadata (channel-agnostic). */
export type ApprovalArtifact = {
  tool: string;
  channelId?: string;
  channelName?: string;
  threadTs?: string;
  body?: string;
  informationClass?: string;
  audience?: string;
  to?: string;
  subject?: string;
  datetime?: string;
  counterpart?: string;
  title?: string;
  vendor?: string;
  destination?: string;
  amountJpy?: number;
  what?: string;
};

const CLASS_LABEL: Record<string, string> = {
  public: "公開",
  internal: "社内",
  confidential: "機密",
  verbatim: "原文",
};

const AUDIENCE_LABEL: Record<string, string> = {
  internal: "社内",
  external: "社外",
  unknown: "不明",
};

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = str(value);
    if (found) return found;
  }
  return undefined;
}

function argsOf(body: GatewayInvokeRequest | undefined | null): Record<string, unknown> {
  return body?.args && typeof body.args === "object"
    ? (body.args as Record<string, unknown>)
    : {};
}

function finiteAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Extract the outbound artifact a human must see before approving. */
export function buildApprovalArtifact(
  tool: string,
  body: GatewayInvokeRequest | undefined | null,
  egress: EgressVerdict | null | undefined,
  conversation: ConversationContext | null | undefined
): ApprovalArtifact {
  const args = argsOf(body);
  const artifact: ApprovalArtifact = { tool };
  const channelId =
    conversation?.slackChannelId ||
    conversation?.slackUserId ||
    firstString(args.slackChannelId, args.channelId, args.channel);
  const channelName = firstString(
    args.channelName,
    args.channel_name,
    args.slackChannelName
  );
  const threadTs = resolveConversationThreadId({
    conversation,
    args,
    body,
  });
  const outbound = outboundConversationText(args);
  const mailBody = firstString(args.body, args.text, args.message, args.content);

  if (
    tool === "comm.reply" ||
    tool === "comm.send" ||
    tool === "slack.post" ||
    tool === "slack.post_external"
  ) {
    if (channelId) artifact.channelId = channelId;
    if (channelName) artifact.channelName = channelName;
    if (threadTs) artifact.threadTs = threadTs;
    if (outbound) artifact.body = outbound;
    if (egress?.informationClass) artifact.informationClass = egress.informationClass;
    const audience = egress?.effectiveAudience || egress?.audience;
    if (audience) artifact.audience = audience;
  }

  if (tool === "mail.send" || tool === "mail.draft") {
    const to = firstString(
      args.to,
      args.recipient,
      args.email,
      body?.email,
      conversation?.email
    );
    const subject = firstString(args.subject, args.title);
    if (to) artifact.to = to;
    if (subject) artifact.subject = subject;
    if (mailBody) artifact.body = mailBody;
  }

  if (tool === "calendar.confirm" || tool === "calendar.propose") {
    const datetime = firstString(
      args.datetime,
      args.start,
      args.when,
      args.startAt,
      args.start_at
    );
    const counterpart = firstString(
      args.counterpart,
      args.attendee,
      args.with,
      args.calendarWith,
      args.guest
    );
    const title = firstString(args.title, args.summary, args.eventTitle);
    if (datetime) artifact.datetime = datetime;
    if (counterpart) artifact.counterpart = counterpart;
    if (title) artifact.title = title;
  }

  if (tool === "commerce.order" || tool === "commerce.quote") {
    const vendor = firstString(args.vendor, args.merchant, args.seller);
    const destination = firstString(
      args.destination,
      args.shipTo,
      args.ship_to,
      args.address
    );
    const what = firstString(
      args.what,
      args.item,
      args.product,
      args.description,
      args.goods
    );
    const amount = finiteAmount(body?.amountJpy ?? args.amountJpy ?? args.amount);
    if (vendor) artifact.vendor = vendor;
    if (destination) artifact.destination = destination;
    if (what) artifact.what = what;
    if (amount != null) artifact.amountJpy = amount;
  }

  return artifact;
}

export function formatArtifactLines(artifact: ApprovalArtifact): string[] {
  const lines: string[] = [];
  if (artifact.channelId) {
    const name = artifact.channelName ? `（${artifact.channelName}）` : "";
    lines.push(`チャネル: ${artifact.channelId}${name}`);
  }
  if (artifact.threadTs) lines.push(`スレッド: ${artifact.threadTs}`);
  if (artifact.to) lines.push(`宛先: ${artifact.to}`);
  if (artifact.subject) lines.push(`件名: ${artifact.subject}`);
  if (artifact.datetime) lines.push(`日時: ${artifact.datetime}`);
  if (artifact.counterpart) lines.push(`相手: ${artifact.counterpart}`);
  if (artifact.title) lines.push(`タイトル: ${artifact.title}`);
  if (artifact.vendor) lines.push(`発注先: ${artifact.vendor}`);
  if (artifact.destination) lines.push(`配送先: ${artifact.destination}`);
  if (artifact.amountJpy != null && Number.isFinite(artifact.amountJpy)) {
    lines.push(`金額: ¥${Math.round(artifact.amountJpy).toLocaleString("ja-JP")}`);
  }
  if (artifact.what) lines.push(`内容: ${artifact.what}`);
  if (artifact.informationClass) {
    lines.push(
      `情報区分: ${CLASS_LABEL[artifact.informationClass] || artifact.informationClass}`
    );
  }
  if (artifact.audience) {
    lines.push(`相手先: ${AUDIENCE_LABEL[artifact.audience] || artifact.audience}`);
  }
  if (artifact.body) {
    lines.push("本文:");
    lines.push(artifact.body);
  }
  return lines;
}

/**
 * Extra ticket lines (body, dest, class) so a human can see WHAT they are allowing.
 * Telegram and dashboard both render approval.summary which includes these lines.
 */
export function buildArtifactLines(
  tool: string,
  body: GatewayInvokeRequest | undefined | null,
  egress: EgressVerdict | null | undefined,
  conversation: ConversationContext | null | undefined
): string[] {
  return formatArtifactLines(buildApprovalArtifact(tool, body, egress, conversation));
}

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
