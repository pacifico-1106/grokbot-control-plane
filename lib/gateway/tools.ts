/**
 * Gateway tool allowlist (P0 contract — Kimura + Ando A).
 * Unregistered tools are rejected fail-closed.
 * confirm / send paths always force needs_approval (always_human default).
 * propose / draft may auto under employee approvalPolicy.
 */

export type GatewayToolId =
  | "tools.ping"
  | "tools.read"
  | "calendar.read"
  | "calendar.propose"
  | "calendar.confirm"
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
    requiredScopes: ["calendar:propose", "tools:read", "tools:invoke"],
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
  "mail.draft": {
    id: "mail.draft",
    labelJa: "メール下書き",
    kind: "draft",
    requiredScopes: ["mail:draft"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "mail.send": {
    id: "mail.send",
    labelJa: "メール送信",
    kind: "send",
    requiredScopes: ["mail:send"],
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
    labelJa: "Slack 社内投稿",
    kind: "mutate",
    requiredScopes: ["tools:invoke"],
    forceNeedsApproval: false,
    mayAuto: true,
  },
  "slack.post_external": {
    id: "slack.post_external",
    labelJa: "Slack 社外・顧客向け投稿",
    kind: "send",
    requiredScopes: ["tools:invoke"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "drive.share_external": {
    id: "drive.share_external",
    labelJa: "Drive 社外共有リンク発行",
    kind: "send",
    requiredScopes: ["files:write"],
    forceNeedsApproval: true,
    mayAuto: false,
  },
  "knowledge.search": {
    id: "knowledge.search",
    labelJa: "社内ナレッジ検索",
    kind: "read",
    requiredScopes: ["tools:read", "files:read"],
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

/** Tools that always queue for human approval at the gateway. */
export function isForceApprovalTool(def: GatewayToolDef): boolean {
  return (
    def.forceNeedsApproval ||
    def.kind === "confirm" ||
    def.kind === "send" ||
    def.kind === "order"
  );
}

export function employeeHasToolScope(
  scopes: string[] | undefined | null,
  def: GatewayToolDef
): boolean {
  if (!def.requiredScopes.length) return true;
  const set = new Set(scopes ?? []);
  return def.requiredScopes.some((s) => set.has(s));
}
