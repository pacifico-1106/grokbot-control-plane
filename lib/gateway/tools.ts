import type { ApprovalPolicy } from "@/lib/types";

/**
 * Gateway tool allowlist (P0 contract — Kimura + Ando A).
 * Unregistered tools are rejected fail-closed.
 * confirm / send default needs_approval; choosable tools honor per-tool hints (mail.send, calendar.confirm, commerce.order, files.write, drive.share_external, browser.use, sns.publish).
 * propose / draft may auto under employee approvalPolicy.
 */

export type GatewayToolId =
  | "tools.ping"
  | "tools.read"
  | "calendar.read"
  | "calendar.propose"
  | "calendar.confirm"
  | "calendar.allowlist.patch"
  | "mail.draft"
  | "mail.send"
  | "agentmail.draft"
  | "agentmail.send"
  | "files.read"
  | "files.write"
  | "browser.use"
  | "commerce.quote"
  | "commerce.order"
  | "slack.post"
  | "slack.post_external"
  | "comm.reply"
  | "comm.send"
  | "comm.delete"
  | "sns.publish"
  | "drive.share_external"
  | "knowledge.search"
  | "approvals.request"
  | "audit.append";

export type GatewayToolKind =
  | "ping"
  | "read"
  | "propose"
  | "confirm"
  | "draft"
  | "send"
  | "mutate"
  | "order"
  | "reserved";

export interface GatewayToolDef {
  id: GatewayToolId;
  /** Human-facing JP label */
  labelJa: string;
  kind: GatewayToolKind;
  /**
   * Employee scopes that authorize this tool (any match).
   * Empty = always allowed when employee is executable (ping).
   */
  requiredScopes: string[];
  /** Force needs_approval regardless of employee.approvalPolicy */
  forceNeedsApproval: boolean;
  /** May run under auto / risk_based when not forced */
  mayAuto: boolean;
  /** P0.5 schema/policy reservation — not live-integrated */
  reserved?: boolean;
}

/** Canonical allowlist. Unknown tools → reject. */
export const GATEWAY_TOOL_DEFS: Record<GatewayToolId, GatewayToolDef> = {
  "tools.ping": {
    id: "tools.ping",
    labelJa: "ヘルス確認",
    kind: "ping",
    requiredScopes: [],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "tools.read": {
    id: "tools.read",
    labelJa: "ツール読取",
    kind: "read",
    requiredScopes: ["tools:read"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "calendar.read": {
    id: "calendar.read",
    labelJa: "社内カレンダー参照",
    kind: "read",
    requiredScopes: ["calendar:read", "calendar:propose", "tools:read", "tools:invoke"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "calendar.propose": {
    id: "calendar.propose",
    labelJa: "空き枠の提案",
    kind: "propose",
    requiredScopes: ["calendar:propose", "tools:invoke"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "calendar.confirm": {
    id: "calendar.confirm",
    labelJa: "日程の確定（invite / 承諾）",
    kind: "confirm",
    requiredScopes: ["calendar:confirm", "tools:invoke"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "calendar.allowlist.patch": {
    id: "calendar.allowlist.patch",
    labelJa: "カレンダー参照許可リスト変更",
    kind: "mutate",
    requiredScopes: ["calendar:read", "tools:invoke"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "mail.draft": {
    id: "mail.draft",
    labelJa: "メール下書き",
    kind: "draft",
    requiredScopes: ["agentmail:draft", "mail:draft"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "mail.send": {
    id: "mail.send",
    labelJa: "メール送信",
    kind: "send",
    requiredScopes: ["agentmail:send", "mail:send"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "agentmail.draft": {
    id: "agentmail.draft",
    labelJa: "AgentMail 下書き（P0.5予約）",
    kind: "reserved",
    requiredScopes: ["mail:draft"],
    forceNeedsApproval: false,
    mayAuto: true,
    reserved: true,
  },
  "agentmail.send": {
    id: "agentmail.send",
    labelJa: "AgentMail 送信（P0.5予約）",
    kind: "reserved",
    requiredScopes: ["mail:send"],
    forceNeedsApproval: true,
    mayAuto: false,
    reserved: true,
  },
  "files.read": {
    id: "files.read",
    labelJa: "ファイル読取",
    kind: "read",
    requiredScopes: ["files:read"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "files.write": {
    id: "files.write",
    labelJa: "ファイル書込 / マスタ更新",
    kind: "mutate",
    requiredScopes: ["files:write"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "browser.use": {
    id: "browser.use",
    labelJa: "ブラウザ利用",
    kind: "mutate",
    requiredScopes: ["browser:use"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "commerce.quote": {
    id: "commerce.quote",
    labelJa: "見積作成",
    kind: "propose",
    requiredScopes: ["commerce:quote"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "commerce.order": {
    id: "commerce.order",
    labelJa: "発注・購入",
    kind: "order",
    requiredScopes: ["commerce:order"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "slack.post": {
    id: "slack.post",
    labelJa: "Slack 投稿（エイリアス・相手解決が境界）",
    kind: "mutate",
    requiredScopes: ["slack:post", "tools:invoke"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "slack.post_external": {
    id: "slack.post_external",
    labelJa: "Slack 投稿エイリアス（ツール名は境界ではない）",
    kind: "mutate",
    requiredScopes: ["slack:post_external", "slack:post", "tools:invoke"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "comm.reply": {
    id: "comm.reply",
    labelJa: "会話返信（相手×情報区分）",
    kind: "mutate",
    requiredScopes: ["tools:invoke", "slack:post", "mail:send"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "comm.send": {
    id: "comm.send",
    labelJa: "会話送信（相手×情報区分）",
    kind: "mutate",
    requiredScopes: ["tools:invoke", "slack:post", "mail:send"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "comm.delete": {
    id: "comm.delete",
    labelJa: "自分の投稿の削除（記録済みの自分の投稿のみ）",
    kind: "mutate",
    requiredScopes: ["tools:invoke", "slack:post"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "sns.publish": {
    id: "sns.publish",
    labelJa: "個人SNS投稿（X / note / LinkedIn / YouTube）",
    kind: "send",
    requiredScopes: ["sns:publish"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "drive.share_external": {
    id: "drive.share_external",
    labelJa: "Drive 社外共有リンク発行",
    kind: "send",
    requiredScopes: ["drive:share_external", "files:write"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "knowledge.search": {
    id: "knowledge.search",
    labelJa: "社内ナレッジ検索",
    kind: "read",
    requiredScopes: ["knowledge:search", "tools:read", "files:read"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "approvals.request": {
    id: "approvals.request",
    labelJa: "承認申請",
    kind: "propose",
    requiredScopes: ["approvals:request"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "audit.append": {
    id: "audit.append",
    labelJa: "監査追記",
    kind: "mutate",
    requiredScopes: ["audit:append"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
};

const ALIASES: Record<string, GatewayToolId> = {
  "tools:ping": "tools.ping",
  "tools:read": "tools.read",
  "tools:invoke": "tools.read",
  "calendar:read": "calendar.read",
  "calendar:propose": "calendar.propose",
  "calendar:confirm": "calendar.confirm",
  "calendar:allowlist.patch": "calendar.allowlist.patch",
  "calendar.allowlist:patch": "calendar.allowlist.patch",
  "mail:draft": "mail.draft",
  "mail:send": "mail.send",
  "agentmail:draft": "agentmail.draft",
  "agentmail:send": "agentmail.send",
  "files:read": "files.read",
  "files:write": "files.write",
  "browser:use": "browser.use",
  "commerce:quote": "commerce.quote",
  "commerce:order": "commerce.order",
  "slack:post": "slack.post",
  "slack:post_external": "slack.post_external",
  "comm:reply": "comm.reply",
  "comm:send": "comm.send",
  "comm.reply": "comm.reply",
  "comm.send": "comm.send",
  "comm:delete": "comm.delete",
  "comm.delete": "comm.delete",
  "sns:publish": "sns.publish",
  "sns.publish": "sns.publish",
  "drive:share_external": "drive.share_external",
  "knowledge:search": "knowledge.search",
  "approvals:request": "approvals.request",
  "audit:append": "audit.append",
};

export function normalizeGatewayTool(raw: string | undefined | null): string {
  return (raw || "").trim().toLowerCase().replace(/\s+/g, "");
}

export function resolveGatewayTool(
  raw: string | undefined | null
): { ok: true; def: GatewayToolDef } | { ok: false; tool: string } {
  const normalized = normalizeGatewayTool(raw);
  if (!normalized) return { ok: false, tool: "" };
  const id = (ALIASES[normalized] ?? normalized) as GatewayToolId;
  const def = GATEWAY_TOOL_DEFS[id];
  if (!def) return { ok: false, tool: normalized };
  return { ok: true, def };
}

export function listGatewayToolIds(): GatewayToolId[] {
  return Object.keys(GATEWAY_TOOL_DEFS) as GatewayToolId[];
}

const ALWAYS_HUMAN_TOOL_IDS = new Set<GatewayToolId>([
  "mail.send",
  "calendar.confirm",
  "calendar.allowlist.patch",
  "commerce.order",
  "drive.share_external",
  "files.write",
  "browser.use",
  "agentmail.send",
  "sns.publish",
]);

const AUDIENCE_GATED_TOOL_IDS = new Set<GatewayToolId>([
  "comm.send",
  "comm.reply",
  "slack.post",
  "slack.post_external",
]);

/**
 * Outbound-send tools: the effect is a message, post or share that leaves
 * Staffpass (mail, Slack / conversation surfaces, personal SNS, external
 * share links). A per-tool `deny` setting on any of these is a hard stop at
 * invoke time AND right before an approved item is executed (fulfill).
 *
 * Classification of every registry entry lives in OUTBOUND_SEND_CLASSIFICATION
 * (tools.outbound.test.ts fails if a new tool is added without a decision).
 */
export const OUTBOUND_SEND_TOOL_IDS = [
  "mail.send",
  "agentmail.send",
  "slack.post",
  "slack.post_external",
  "comm.reply",
  "comm.send",
  "sns.publish",
  "drive.share_external",
] as const satisfies readonly GatewayToolId[];

export type OutboundSendToolId = (typeof OUTBOUND_SEND_TOOL_IDS)[number];

const OUTBOUND_SEND_TOOL_ID_SET = new Set<GatewayToolId>(OUTBOUND_SEND_TOOL_IDS);

/** True when a per-tool `deny` must reject this tool immediately (no approval card). */
export function isOutboundSendTool(def: GatewayToolDef | string): boolean {
  const id = typeof def === "string" ? def : def.id;
  return OUTBOUND_SEND_TOOL_ID_SET.has(id as GatewayToolId);
}

/**
 * Registry tools intentionally NOT treated as outbound-send, with the reason.
 * For these a `deny` hint keeps the previous behaviour (no immediate reject).
 */
export const NON_OUTBOUND_TOOL_REASONS: Readonly<Record<Exclude<GatewayToolId, OutboundSendToolId>, string>> = {
  "tools.ping": "ヘルス確認。外部へ何も送らない",
  "tools.read": "読み取りのみ",
  "calendar.read": "読み取りのみ",
  "calendar.propose": "空き枠の提案（相手への送信なし）",
  "calendar.confirm": "日程の確定。メッセージ送信ではなく予定操作（招待送付は未実装スタブ）。常に人の承認",
  "calendar.allowlist.patch": "社内設定の変更。外部送信なし",
  "mail.draft": "下書きのみ。送信しない",
  "agentmail.draft": "下書きのみ（P0.5 予約、invoke で拒否済み）",
  "files.read": "読み取りのみ",
  "files.write": "ファイル書込。外部送信ではない。常に人の承認",
  "browser.use": "ブラウザ操作。送信先を特定できない汎用操作。常に人の承認",
  "commerce.quote": "見積作成（送信なし）",
  "commerce.order": "発注。送信ではなく購買（支出ゲート・常に人の承認）",
  "knowledge.search": "社内検索のみ",
  "approvals.request": "社内の承認依頼（承認者向け通知面。外部送信ではない）",
  "audit.append": "監査追記（社内記録）",
  "comm.delete":
    "自分の記録済み投稿の削除。新たな送信・開示はしない（記録で本人の投稿に限定。deny は即時拒否・承認後も再確認、lib/comm-delete）",
};

/** slack.* / comm.* share one audience resolver — tool name is not the boundary. */
/** Conversation tools (one shared duplicate-reply ledger, lib/comm-reply-dedup). */
export function audienceGatedToolIds(): GatewayToolId[] {
  return [...AUDIENCE_GATED_TOOL_IDS];
}

export function isAudienceGatedTool(def: GatewayToolDef | string): boolean {
  const id = typeof def === "string" ? def : def.id;
  return AUDIENCE_GATED_TOOL_IDS.has(id as GatewayToolId);
}

export function isAlwaysHumanTool(def: GatewayToolDef | string): boolean {
  const id = typeof def === "string" ? def : def.id;
  return ALWAYS_HUMAN_TOOL_IDS.has(id as GatewayToolId);
}

/** Personal SNS posts are fulfill-on-approve, not Slack audience-gated. */
export function isSnsPublishTool(def: GatewayToolDef | string): boolean {
  const id = typeof def === "string" ? def : def.id;
  return id === "sns.publish";
}

/**
 * Audience-gated tools whose explicit per-tool `always_human` setting is honoured.
 * Stricter-only: it can add a human approval, never remove one; auto / risk_based /
 * unset keep the audience × class decision. Covers every audience-gated tool
 * (木村 2026-10-04, #249).
 */
export const AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS = [
  "comm.reply",
  "comm.send",
  "slack.post",
  "slack.post_external",
] as const satisfies readonly GatewayToolId[];

function honorsAlwaysHumanHint(id: GatewayToolId): boolean {
  return (AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS as readonly GatewayToolId[]).includes(id);
}

/**
 * Per-tool hints can loosen choosable always-human tools (send / confirm / order / write / browser).
 * Audience-gated tools never force from the tool name; employee policy + egress decide
 * (an explicit always_human on comm.* / slack.* is employee policy and forces approval).
 * Missing hints keep the strict always-human defaults.
 */
export function toolRequiresHumanApproval(
  def: GatewayToolDef,
  toolApprovalDefaults?: Record<string, ApprovalPolicy | "deny"> | null
): boolean {
  const hint = toolApprovalDefaults?.[def.id];
  if (isAudienceGatedTool(def)) return hint === "always_human" && honorsAlwaysHumanHint(def.id);
  if (hint === "auto" || hint === "risk_based") return false;
  if (hint === "always_human") return true;
  return isForceApprovalTool(def);
}

/** Tools that always queue for human approval at the gateway. */
export function isForceApprovalTool(def: GatewayToolDef): boolean {
  if (isAudienceGatedTool(def)) return false;
  if (isAlwaysHumanTool(def)) return true;
  return (
    def.forceNeedsApproval ||
    def.kind === "confirm" ||
    def.kind === "send" ||
    def.kind === "order"
  );
}

/**
 * Confirm-class for Ando BM metering: mail.send, calendar.confirm, commerce.order,
 * and any allowlisted tool marked kind confirm | send | order.
 * Propose / draft / read are never confirm-class.
 */
export function isConfirmClassTool(def: GatewayToolDef): boolean {
  return def.kind === "confirm" || def.kind === "send" || def.kind === "order";
}

export function employeeHasToolScope(
  scopes: string[] | undefined | null,
  def: GatewayToolDef
): boolean {
  if (!def.requiredScopes.length) return true;
  const set = new Set(scopes ?? []);
  return def.requiredScopes.some((s) => set.has(s));
}
