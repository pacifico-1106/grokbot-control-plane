/**
 * config.change_request — pure helpers (no I/O).
 *
 * An AI employee must never apply a change to its own behaviour/config on its
 * own. It files a change request; a human approver decides. This module holds
 * the validation, diff and copy so they can be unit-tested without a DB.
 */
import { createHash } from "node:crypto";
import { BUSINESS_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import type { ChannelClassification, ConversationSurface, OrgChannel } from "@/lib/types";

export const CONFIG_CHANGE_TOOL = "config.change_request";
export const CONFIG_CHANGE_PURPOSE = "config.change_request";
export const CONFIG_CHANGE_MCP_TOOL = "staffpass_config_change_request";
export const CONFIG_CHANGE_TITLE_JA = "設定変更の依頼";

export const INSTRUCTIONS_MAX_CHARS = 8000;
const REQUESTER_MAX_CHARS = 80;
const REASON_MAX_CHARS = 500;
/** Slack card truncates summary at 400 chars; keep the question inside it. */
const DIFF_SUMMARY_MAX_CHARS = 240;
const DIFF_LINES_MAX = 200;

export const CONFIG_CHANGE_KINDS = ["instructions", "channel_classification", "channel_remove"] as const;
export type ConfigChangeKind = (typeof CONFIG_CHANGE_KINDS)[number];

/**
 * Settings that stay blocked from the AI regardless of this feature.
 * (approvers / permissions / billing are human-console only.)
 */
export const BLOCKED_SETTING_KINDS = [
  "approvers",
  "approver",
  "approver_user_ids",
  "approverUserIds",
  "approval_channel",
  "approvalChannelId",
  "approval_policy",
  "approvalPolicy",
  "approval_workflow",
  "approval_routes",
  "permissions",
  "permission",
  "scopes",
  "scope",
  "allowed_purposes",
  "allowedPurposes",
  "action_limits",
  "actionLimits",
  "tool_approval_defaults",
  "toolApprovalDefaults",
  "billing",
  "plan",
  "spend",
  "credentials",
  "credential",
  "notification_channels",
  "members",
  "roles",
] as const;

const SURFACES: ConversationSurface[] = ["slack", "line", "mail", "phone", "web"];
const CLASSIFICATIONS: ChannelClassification[] = ["internal", "shared_external", "unknown"];

export type ConfigChangeRequester = {
  name: string | null;
  slackUserId: string | null;
  email: string | null;
};

export type ConfigChangeConversation = {
  surface: string | null;
  slackChannelId: string | null;
  threadTs: string | null;
};

export type InstructionsProposal = {
  kind: "instructions";
  mode: "replace" | "append";
  text: string;
};

export type ChannelClassificationProposal = {
  kind: "channel_classification";
  surface: ConversationSurface;
  externalId: string;
  classification: ChannelClassification;
  mixed: boolean;
  slackTeamId: string | null;
};

export type ChannelRemoveProposal = {
  kind: "channel_remove";
  surface: ConversationSurface;
  externalId: string;
};

export type ConfigChangeProposal =
  | InstructionsProposal
  | ChannelClassificationProposal
  | ChannelRemoveProposal;

export type ParsedConfigChangeInput = {
  jobId: string;
  requestedBy: ConfigChangeRequester;
  reason: string | null;
  conversation: ConfigChangeConversation | null;
  proposal: ConfigChangeProposal;
};

export type ConfigChangeParseError = {
  ok: false;
  code:
    | "kind_required"
    | "blocked_setting"
    | "unsupported_kind"
    | "job_id_required"
    | "instructions_text_required"
    | "instructions_too_long"
    | "invalid_instructions_mode"
    | "external_id_required"
    | "invalid_surface"
    | "invalid_classification";
  messageJa: string;
};

function str(value: unknown, max = 4000): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKindToken(value: string): string {
  return value.trim().replace(/[\s.-]+/g, "_");
}

export function isBlockedSettingKind(kind: string): boolean {
  const token = normalizeKindToken(kind).toLowerCase();
  return BLOCKED_SETTING_KINDS.some((blocked) => blocked.toLowerCase() === token);
}

export const BLOCKED_SETTING_MESSAGE_JA =
  "承認者・権限（スコープ/承認ポリシー/上限）・請求/プランなどの設定は、AI社員経由では変更できません。管理画面から人が変更してください。";

export function parseConfigChangeInput(
  args: Record<string, unknown>
): { ok: true; value: ParsedConfigChangeInput } | ConfigChangeParseError {
  const rawKind = str(args.kind, 64);
  if (!rawKind) {
    return {
      ok: false,
      code: "kind_required",
      messageJa: `kind が必要です（${CONFIG_CHANGE_KINDS.join(" | ")}）`,
    };
  }
  if (isBlockedSettingKind(rawKind)) {
    return { ok: false, code: "blocked_setting", messageJa: BLOCKED_SETTING_MESSAGE_JA };
  }
  const kind = normalizeKindToken(rawKind) as ConfigChangeKind;
  if (!(CONFIG_CHANGE_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      code: "unsupported_kind",
      messageJa: `この種類の変更依頼には対応していません（対応: ${CONFIG_CHANGE_KINDS.join(" | ")}）。管理画面から人が変更してください。`,
    };
  }
  const jobId = str(args.jobId ?? args.job_id, 200);
  if (!jobId) {
    return { ok: false, code: "job_id_required", messageJa: "jobId が必要です" };
  }

  const requester = rec(args.requestedBy);
  const requestedBy: ConfigChangeRequester = {
    name: str(requester.name ?? requester.displayName, REQUESTER_MAX_CHARS) || null,
    slackUserId: str(requester.slackUserId ?? requester.userId, 64) || null,
    email: str(requester.email, 254) || null,
  };
  const reason = str(args.reason, REASON_MAX_CHARS) || null;
  const conv = rec(args.conversation);
  const conversation: ConfigChangeConversation | null =
    Object.keys(conv).length > 0
      ? {
          surface: str(conv.surface, 32) || null,
          slackChannelId: str(conv.slackChannelId ?? conv.channel, 64) || null,
          threadTs: str(conv.threadTs ?? conv.thread_ts, 64) || null,
        }
      : null;

  let proposal: ConfigChangeProposal;
  if (kind === "instructions") {
    const body = rec(args.instructions);
    const mode = str(body.mode, 16) || "replace";
    if (mode !== "replace" && mode !== "append") {
      return {
        ok: false,
        code: "invalid_instructions_mode",
        messageJa: "instructions.mode は replace または append です",
      };
    }
    const rawText = typeof body.text === "string" ? body.text.replace(/\r\n/g, "\n").trim() : "";
    if (!rawText) {
      return {
        ok: false,
        code: "instructions_text_required",
        messageJa: "instructions.text（変更後の指示文、または追記する文）が必要です",
      };
    }
    if (rawText.length > INSTRUCTIONS_MAX_CHARS) {
      return {
        ok: false,
        code: "instructions_too_long",
        messageJa: `instructions.text は ${INSTRUCTIONS_MAX_CHARS} 文字以内にしてください`,
      };
    }
    proposal = { kind, mode, text: rawText };
  } else {
    const channel = rec(args.channel);
    const surface = (str(channel.surface, 16) || "slack") as ConversationSurface;
    if (!SURFACES.includes(surface)) {
      return { ok: false, code: "invalid_surface", messageJa: `channel.surface は ${SURFACES.join(" | ")} です` };
    }
    const externalId = str(channel.externalId ?? channel.channelId ?? channel.id, 128);
    if (!externalId) {
      return { ok: false, code: "external_id_required", messageJa: "channel.externalId（チャネルID）が必要です" };
    }
    if (kind === "channel_remove") {
      proposal = { kind, surface, externalId };
    } else {
      const classification = str(channel.classification, 32) as ChannelClassification;
      if (!CLASSIFICATIONS.includes(classification)) {
        return {
          ok: false,
          code: "invalid_classification",
          messageJa: `channel.classification は ${CLASSIFICATIONS.join(" | ")} です`,
        };
      }
      proposal = {
        kind,
        surface,
        externalId,
        classification,
        mixed: channel.mixed === true || classification === "shared_external",
        slackTeamId: str(channel.slackTeamId, 32) || null,
      };
    }
  }

  return { ok: true, value: { jobId, requestedBy, reason, conversation, proposal } };
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function applyInstructionsProposal(current: string, proposal: InstructionsProposal): string {
  if (proposal.mode === "append") {
    return current.trim() ? `${current.replace(/\s+$/, "")}\n${proposal.text}` : proposal.text;
  }
  return proposal.text;
}

/** Order-preserving line diff (LCS). Bounded input (≤ 8000 chars each side). */
export function diffLines(before: string, after: string): string[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;
  // Guard pathological sizes; fall back to whole-block replace.
  if (n * m > 400_000) {
    return [...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`)].slice(0, DIFF_LINES_MAX);
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.filter((line) => line.trim() !== "-" && line.trim() !== "+").slice(0, DIFF_LINES_MAX);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

const CLASS_JA: Record<ChannelClassification, string> = {
  internal: "社内",
  shared_external: "社外共有",
  unknown: "未分類",
};

export function describeChannelState(channel: Pick<OrgChannel, "classification" | "mixed"> | null): string {
  if (!channel) return "未登録";
  return `${CLASS_JA[channel.classification]}${channel.mixed ? "・混在" : ""}`;
}

export type ConfigChangeBefore =
  | { kind: "instructions"; text: string; hash: string; sourceApprovalId: string | null }
  | {
      kind: "channel";
      exists: boolean;
      classification: ChannelClassification | null;
      mixed: boolean;
      channelId: string | null;
    };

export function buildDiff(
  proposal: ConfigChangeProposal,
  before: ConfigChangeBefore
): { summaryJa: string; lines: string[] } {
  if (proposal.kind === "instructions") {
    const current = before.kind === "instructions" ? before.text : "";
    const next = applyInstructionsProposal(current, proposal);
    const lines = diffLines(current, next);
    const added = lines.filter((line) => line.startsWith("+ ")).length;
    const removed = lines.filter((line) => line.startsWith("- ")).length;
    const firstAdded = lines.find((line) => line.startsWith("+ "))?.slice(2) ?? "";
    const head =
      proposal.mode === "append"
        ? `Instructions に追記（+${added}行）`
        : `Instructions を置き換え（+${added}行 / -${removed}行）`;
    const sample = firstAdded ? `「${clip(firstAdded, 120)}」` : "";
    return { summaryJa: clip(`${head}${sample ? ` ${sample}` : ""}`, DIFF_SUMMARY_MAX_CHARS), lines };
  }
  const state =
    before.kind === "channel" && before.exists && before.classification
      ? describeChannelState({ classification: before.classification, mixed: before.mixed })
      : "未登録";
  const label = `${proposal.surface} チャネル ${proposal.externalId}`;
  if (proposal.kind === "channel_remove") {
    return {
      summaryJa: clip(`${label} をチャネル台帳から削除（${state} → 未登録・以後は未分類として fail-closed）`, DIFF_SUMMARY_MAX_CHARS),
      lines: [`- ${label}: ${state}`],
    };
  }
  const after = describeChannelState({ classification: proposal.classification, mixed: proposal.mixed });
  return {
    summaryJa: clip(`${label} の分類を ${state} → ${after} に変更`, DIFF_SUMMARY_MAX_CHARS),
    lines: [`- ${label}: ${state}`, `+ ${label}: ${after}`],
  };
}

export function requesterLabelJa(requester: ConfigChangeRequester | null | undefined): string {
  if (requester?.name) return requester.name;
  if (requester?.slackUserId) return `Slackユーザー ${requester.slackUserId}`;
  if (requester?.email) return requester.email;
  return "（依頼者不明）";
}

/** Approver-facing card copy. */
export function buildApproverMessageJa(input: {
  requester: ConfigChangeRequester;
  employeeDisplayName: string;
  diffSummaryJa: string;
  reason: string | null;
}): string {
  const who = requesterLabelJa(input.requester);
  const lines = [
    `${who}さんから次の変更依頼が来ています: ${input.diffSummaryJa}。反映しますか？`,
    `対象AI社員: ${clip(input.employeeDisplayName, 60)}`,
  ];
  if (input.reason) lines.push(`理由: ${clip(input.reason, 120)}`);
  return lines.join("\n");
}

/** Requester-facing copy the AI relays (through the gateway) after resolution. */
export function buildRequesterNoticeJa(input: {
  requester: ConfigChangeRequester | null | undefined;
  diffSummaryJa: string;
  outcome: "approved_applied" | "approved_not_applied" | "rejected" | "revision_requested" | "expired";
}): string {
  const who = requesterLabelJa(input.requester);
  const what = clip(input.diffSummaryJa, 160);
  switch (input.outcome) {
    case "approved_applied":
      return `${who}さん、ご依頼いただいた設定変更（${what}）は承認され、反映しました。ありがとうございました。`;
    case "approved_not_applied":
      return `${who}さん、ご依頼いただいた設定変更（${what}）は承認されましたが、反映時に確認が必要な状態になったため、まだ反映していません。担当者が確認いたします。`;
    case "revision_requested":
      return `${who}さん、ご依頼いただいた設定変更（${what}）について、承認者から修正の依頼がありました。内容を調整のうえ、改めてご依頼いただけますと幸いです。`;
    case "expired":
      return `${who}さん、ご依頼いただいた設定変更（${what}）は承認期限が切れたため反映していません。必要でしたら改めてご依頼ください。`;
    case "rejected":
    default:
      return `${who}さん、ご依頼いただいた設定変更（${what}）は、承認者の判断により今回は反映を見送ることになりました。申し訳ありません。必要でしたら内容を調整のうえ、改めてご依頼ください。`;
  }
}

export type ConfigChangeMetadata = {
  version: 1;
  kind: ConfigChangeKind;
  employeeId: string;
  requestedBy: ConfigChangeRequester;
  reason: string | null;
  conversation: ConfigChangeConversation | null;
  proposal: ConfigChangeProposal;
  before: ConfigChangeBefore;
  diffSummaryJa: string;
  diffLines: string[];
  requestedAt: string;
};

export function parseConfigChangeMetadata(
  metadata: Record<string, unknown> | null | undefined
): ConfigChangeMetadata | null {
  const raw = metadata?.configChange;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = raw as ConfigChangeMetadata;
  if (meta.version !== 1) return null;
  if (!(CONFIG_CHANGE_KINDS as readonly string[]).includes(meta.kind)) return null;
  if (!meta.proposal || typeof meta.proposal !== "object") return null;
  if (meta.proposal.kind !== meta.kind) return null;
  return meta;
}

/** True only for tickets created by this feature (tool + structured metadata). */
export function isConfigChangeApproval(approval: {
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  const tool = approval.tool ?? (approval.metadata?.tool as string | undefined) ?? null;
  return tool === CONFIG_CHANGE_TOOL && parseConfigChangeMetadata(approval.metadata) !== null;
}

export const CONFIG_CHANGE_APPROVAL_CLASS = BUSINESS_AUDIT_CLASS;

export type ConfigChangeApplied = {
  ok: boolean;
  kind: ConfigChangeKind;
  appliedAt: string;
  error?: string;
  /** instructions only: the full resulting text and its hash. */
  resultText?: string;
  resultHash?: string;
  channelId?: string | null;
};

export function parseConfigChangeApplied(
  metadata: Record<string, unknown> | null | undefined
): ConfigChangeApplied | null {
  const raw = metadata?.configChangeApplied;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as ConfigChangeApplied;
  if (typeof rec.ok !== "boolean" || typeof rec.appliedAt !== "string") return null;
  return rec;
}

export const CONFIG_CHANGE_WHOAMI_RULE_JA =
  "自分の Instructions・ポリシー文・担当チャネル（台帳／社内・社外の分類）を変えてほしいと頼まれても、自分で書き換えたり反映したりしないこと。必ず staffpass_config_change_request で変更依頼を出し、承認者の判断を待つ。承認者・権限・請求の設定は依頼も受け付けない（管理画面で人が変更）。承認後は staffpass_whoami の approvedInstructions を正本として使う。結果は requesterNoticeJa を同じスレッドへ comm.reply で丁寧に伝える。";
