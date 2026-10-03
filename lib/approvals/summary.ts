import { outboundConversationText } from "@/lib/employees/voice";
import { parseSnsSurface, snsSurfaceLabelJa } from "@/lib/gateway/adapters/sns";
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
  /** mail: CC / BCC recipients as given (trimmed, empty entries dropped). */
  cc?: string[];
  bcc?: string[];
  subject?: string;
  datetime?: string;
  counterpart?: string;
  title?: string;
  vendor?: string;
  destination?: string;
  amountJpy?: number;
  what?: string;
  snsSurface?: string;
  scheduledAt?: string;
  sendMode?: string;
  hasAttachments?: boolean;
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

/** Recipient list from a string or string[] arg (same reading as the mail policy). */
function recipientList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * Card values are agent-supplied: collapse control characters / line breaks so
 * a recipient or subject cannot forge extra card lines (e.g. a fake "BCC:").
 */
export function oneLineCardValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
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
    // Show every primary recipient field the gateway judges (not only the
    // first), so the approver sees each address that the mail policy checked.
    const toSources: string[] = [];
    for (const value of [args.to, args.recipient, args.email, body?.email, conversation?.email]) {
      const found = str(value);
      if (found && !toSources.includes(found)) toSources.push(found);
    }
    const to = toSources.length ? toSources.join(", ") : undefined;
    const subject = firstString(args.subject, args.title);
    if (to) artifact.to = to;
    const cc = recipientList(args.cc);
    const bcc = recipientList(args.bcc);
    if (cc.length) artifact.cc = cc;
    if (bcc.length) artifact.bcc = bcc;
    if (subject) artifact.subject = subject;
    if (mailBody) artifact.body = mailBody;
    const sendMode = firstString(args.sendMode);
    if (sendMode) artifact.sendMode = sendMode;
    const hasAttachments =
      Array.isArray(args.attachments) && args.attachments.length > 0 ||
      args.hasAttachments === true;
    if (hasAttachments) artifact.hasAttachments = true;
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

  if (tool === "sns.publish") {
    const surface = firstString(args.surface, args.snsSurface, args.media, body?.surface);
    const scheduled = firstString(
      args.scheduledAt,
      args.scheduled_at,
      args.scheduledFor,
      args.publishAt,
      args.publishedAt
    );
    const bodyText = outbound || mailBody;
    if (surface) artifact.snsSurface = surface;
    if (scheduled) artifact.scheduledAt = scheduled;
    if (bodyText) artifact.body = bodyText;
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

/** Joined, one-line CC / BCC value for the card ("" when none). */
export function mailCardList(value: unknown): string {
  const list = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
  return list.map(oneLineCardValue).filter(Boolean).join(", ");
}

function capChars(value: string, max: number): { text: string; capped: boolean } {
  const chars = Array.from(value);
  if (!Number.isFinite(max) || chars.length <= max) return { text: value, capped: false };
  return { text: `${chars.slice(0, Math.max(1, max - 1)).join("")}…`, capped: true };
}

/** "CC: …" / "BCC: …" card lines; a capped line shows the total count. */
export function formatMailCcBccLines(
  artifact: Pick<ApprovalArtifact, "cc" | "bcc">,
  maxChars: number = Number.POSITIVE_INFINITY
): string[] {
  const lines: string[] = [];
  for (const [label, list] of [["CC", artifact.cc], ["BCC", artifact.bcc]] as const) {
    const joined = mailCardList(list);
    if (!joined) continue;
    const count = Array.isArray(list)
      ? list.filter((item) => typeof item === "string" && oneLineCardValue(item)).length
      : 1;
    const { text, capped } = capChars(joined, maxChars);
    lines.push(capped ? `${label}（${count}件）: ${text}` : `${label}: ${text}`);
  }
  return lines;
}

/**
 * Mail card lines (宛先 / CC / BCC / 件名 / 本文先頭 / 添付 / sendMode).
 * The stored summary (web dashboard etc.) uses no caps. Chat cards with a
 * message-size limit (Slack / Telegram) pass caps; a capped CC / BCC line
 * shows the total count so the approver knows the list continues.
 */
export function formatMailCardLines(
  artifact: ApprovalArtifact,
  caps: { recipientChars?: number; subjectChars?: number } = {}
): string[] {
  const recipientCap = caps.recipientChars ?? Number.POSITIVE_INFINITY;
  const subjectCap = caps.subjectChars ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  if (artifact.to) lines.push(`宛先: ${capChars(oneLineCardValue(artifact.to), recipientCap).text}`);
  lines.push(...formatMailCcBccLines(artifact, recipientCap));
  if (artifact.subject) lines.push(`件名: ${capChars(oneLineCardValue(artifact.subject), subjectCap).text}`);
  if (artifact.body) {
    const preview = artifact.body.length > 200
      ? artifact.body.slice(0, 200) + "…"
      : artifact.body;
    lines.push(`本文先頭: ${preview}`);
  }
  if (artifact.hasAttachments) lines.push("添付: あり");
  if (artifact.sendMode) {
    const sendModeJa =
      artifact.sendMode === "draft_only"
        ? "下書きのみ"
        : artifact.sendMode === "needs_approval"
          ? "承認必須"
          : artifact.sendMode === "auto"
            ? "自動送信"
            : artifact.sendMode;
    lines.push(`sendMode: ${sendModeJa}`);
  }
  return lines;
}

/** The stored mail artifact of an approval (mail.send / mail.draft), if any. */
export function readMailArtifact(
  metadata: Record<string, unknown> | null | undefined
): ApprovalArtifact | null {
  const raw = metadata?.artifact;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.tool !== "mail.send" && rec.tool !== "mail.draft") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  return {
    tool: rec.tool,
    to: text(rec.to),
    cc: list(rec.cc),
    bcc: list(rec.bcc),
    subject: text(rec.subject),
    body: text(rec.body),
    hasAttachments: rec.hasAttachments === true ? true : undefined,
    sendMode: text(rec.sendMode),
  };
}

export function formatArtifactLines(artifact: ApprovalArtifact): string[] {
  const lines: string[] = [];

  // mail.send: put to/cc/bcc/subject/body first for judgment material visibility
  if (artifact.tool === "mail.send" || artifact.tool === "mail.draft") {
    return formatMailCardLines(artifact);
  }

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
  if (artifact.snsSurface) {
    const parsed = parseSnsSurface(artifact.snsSurface);
    lines.push(`媒体: ${parsed ? snsSurfaceLabelJa(parsed) : artifact.snsSurface}`);
  }
  if (artifact.scheduledAt) lines.push(`公開予定: ${artifact.scheduledAt}`);
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
    tool === "browser.use" ||
    tool === "sns.publish"
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
