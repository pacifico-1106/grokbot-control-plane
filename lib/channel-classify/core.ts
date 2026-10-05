/**
 * PR-B channel classification — pure helpers shared by every surface
 * (Slack / LINE / Telegram): request validation for channels.classify /
 * parties.upsert, normalised channel facts, the suggested classification,
 * ticket shapes, and notice wording. No I/O here.
 *
 * Wording is product-neutral (Staffpass = the employee ID badge for AI
 * agents); it never names a specific agent service.
 */
import { createHash } from "node:crypto";
import type { ChannelClassification, ChannelLedgerSurface, OrgPartyKind } from "@/lib/types";

export const CHANNEL_LEDGER_SURFACES = ["slack", "line", "mail", "phone", "web", "telegram"] as const satisfies readonly ChannelLedgerSurface[];
export const CHANNEL_CLASSIFICATIONS = ["internal", "shared_external", "unknown"] as const satisfies readonly ChannelClassification[];
export const PARTY_KINDS = ["email_domain", "slack_channel", "slack_user", "phone", "line", "mail_address"] as const satisfies readonly OrgPartyKind[];
export const PARTY_AUDIENCES = ["internal", "external"] as const;
/** Surfaces whose group / room join events feed the shared proposal flow. */
export const JOIN_SURFACES = ["slack", "line", "telegram"] as const;
export type JoinSurface = (typeof JOIN_SURFACES)[number];

export type ChannelRef = { surface: JoinSurface; externalId: string };

const SURFACE_LABEL: Record<JoinSurface, string> = { slack: "Slack", line: "LINE", telegram: "Telegram" };
export function surfaceLabel(surface: string): string {
  return SURFACE_LABEL[surface as JoinSurface] ?? surface;
}

// ---------------------------------------------------------------- validation
export type ArgValidationError = {
  ok: false;
  code:
    | "invalid_surface"
    | "invalid_classification"
    | "invalid_mixed"
    | "external_id_required"
    | "invalid_external_id"
    | "invalid_kind"
    | "invalid_audience"
    | "identifier_required"
    | "invalid_identifier"
    | "unknown_argument";
  field: string;
  allowed: string[];
  received: string | null;
  message: string;
  messageJa: string;
  nextStep: string;
  nextStepJa: string;
};

export type ChannelsClassifyArgs = {
  surface: ChannelLedgerSurface;
  externalId: string;
  classification: ChannelClassification;
  mixed: boolean;
  employeeId?: string;
  slackTeamId?: string;
};

export type PartiesUpsertArgs = {
  kind: OrgPartyKind;
  identifier: string;
  audience: "internal" | "external";
};

/** Echo a rejected value only as a short, markup-free code. */
function received(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = typeof value === "string" ? value : typeof value;
  const slug = raw.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return slug || null;
}

function reject(
  tool: "channels.classify" | "parties.upsert",
  code: ArgValidationError["code"],
  field: string,
  allowed: readonly string[],
  value: unknown,
  what: string
): ArgValidationError {
  const list = allowed.join(", ");
  return {
    ok: false,
    code,
    field,
    allowed: [...allowed],
    received: received(value),
    message: allowed.length ? `${field} must be one of: ${list}` : `${field} is required`,
    messageJa: allowed.length ? `${what}の値が不正です（許可: ${list}）。何も登録していません。` : `${what}が必要です。何も登録していません。`,
    nextStep: allowed.length
      ? `Call ${tool} again with ${field} set to one of: ${list}.`
      : `Call ${tool} again with ${field} set.`,
    nextStepJa: allowed.length
      ? `${field} を ${list} のいずれかにして ${tool} を呼び直してください。`
      : `${field} を指定して ${tool} を呼び直してください。`,
  };
}

const CONTROL_RE = /[\u0000-\u001f\u007f\s]/;

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : undefined;
}

export const CHANNELS_CLASSIFY_ARG_KEYS = ["surface", "externalId", "identifier", "classification", "mixed", "employeeId", "slackTeamId", "jobId", "approvalId"] as const;
export const PARTIES_UPSERT_ARG_KEYS = ["kind", "identifier", "audience", "jobId", "approvalId"] as const;

/**
 * Request-time only: refuse arguments outside the schema. orgId in particular
 * is refused — the org always comes from the credential.
 */
export function rejectUnknownArgs(
  tool: "channels.classify" | "parties.upsert",
  args: Record<string, unknown>
): ArgValidationError | null {
  const allowed: readonly string[] = tool === "channels.classify" ? CHANNELS_CLASSIFY_ARG_KEYS : PARTIES_UPSERT_ARG_KEYS;
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (!unknown) return null;
  const error = reject(tool, "unknown_argument", unknown, allowed, unknown, "引数");
  if (unknown === "orgId" || unknown === "org_id") {
    error.messageJa = "orgId は指定できません。組織は認証情報（管理MCPの資格情報）から決まります。何も登録していません。";
    error.message = "orgId is not accepted; the org comes from the admin credential.";
    error.nextStep = `Call ${tool} again without orgId.`;
    error.nextStepJa = `orgId を外して ${tool} を呼び直してください。`;
  } else {
    error.messageJa = `未知の引数 ${error.received ?? "?"} です（許可: ${allowed.join(", ")}）。何も登録していません。`;
    error.message = `Unknown argument; allowed: ${allowed.join(", ")}`;
    error.nextStep = `Call ${tool} again with only: ${allowed.join(", ")}.`;
    error.nextStepJa = `${allowed.join(", ")} だけを指定して ${tool} を呼び直してください。`;
  }
  return error;
}

export function validateChannelsClassifyArgs(
  args: Record<string, unknown>
): { ok: true; value: ChannelsClassifyArgs } | ArgValidationError {
  const rawSurface = args.surface === undefined || args.surface === null || args.surface === "" ? "slack" : args.surface;
  if (typeof rawSurface !== "string" || !(CHANNEL_LEDGER_SURFACES as readonly string[]).includes(rawSurface.trim())) {
    return reject("channels.classify", "invalid_surface", "surface", CHANNEL_LEDGER_SURFACES, rawSurface, "surface");
  }
  const rawId = args.externalId ?? args.identifier;
  const externalId = typeof rawId === "string" ? rawId.trim() : "";
  if (!externalId) return reject("channels.classify", "external_id_required", "externalId", [], rawId, "externalId（チャネルID）");
  if (externalId.length > 256 || CONTROL_RE.test(externalId)) {
    return reject("channels.classify", "invalid_external_id", "externalId", [], rawId, "externalId（チャネルID）");
  }
  const rawClass = args.classification === undefined || args.classification === null ? "unknown" : args.classification;
  if (typeof rawClass !== "string" || !(CHANNEL_CLASSIFICATIONS as readonly string[]).includes(rawClass.trim())) {
    return reject("channels.classify", "invalid_classification", "classification", CHANNEL_CLASSIFICATIONS, rawClass, "分類（classification）");
  }
  if (args.mixed !== undefined && typeof args.mixed !== "boolean") {
    return reject("channels.classify", "invalid_mixed", "mixed", ["true", "false"], args.mixed, "mixed");
  }
  return {
    ok: true,
    value: {
      surface: rawSurface.trim() as ChannelLedgerSurface,
      externalId,
      classification: rawClass.trim() as ChannelClassification,
      mixed: args.mixed === true,
      ...(optionalId(args.employeeId) ? { employeeId: optionalId(args.employeeId) } : {}),
      ...(optionalId(args.slackTeamId) ? { slackTeamId: optionalId(args.slackTeamId) } : {}),
    },
  };
}

export function validatePartiesUpsertArgs(
  args: Record<string, unknown>
): { ok: true; value: PartiesUpsertArgs } | ArgValidationError {
  const kind = typeof args.kind === "string" ? args.kind.trim() : args.kind;
  if (typeof kind !== "string" || !(PARTY_KINDS as readonly string[]).includes(kind)) {
    return reject("parties.upsert", "invalid_kind", "kind", PARTY_KINDS, args.kind, "種別（kind）");
  }
  const identifier = typeof args.identifier === "string" ? args.identifier.trim() : "";
  if (!identifier) return reject("parties.upsert", "identifier_required", "identifier", [], args.identifier, "identifier");
  if (identifier.length > 320 || CONTROL_RE.test(identifier)) {
    return reject("parties.upsert", "invalid_identifier", "identifier", [], args.identifier, "identifier");
  }
  const rawAudience = args.audience === undefined || args.audience === null ? "external" : args.audience;
  if (typeof rawAudience !== "string" || !(PARTY_AUDIENCES as readonly string[]).includes(rawAudience.trim())) {
    return reject("parties.upsert", "invalid_audience", "audience", PARTY_AUDIENCES, rawAudience, "相手区分（audience）");
  }
  return { ok: true, value: { kind: kind as OrgPartyKind, identifier, audience: rawAudience.trim() as "internal" | "external" } };
}

// ---------------------------------------------------------------- facts
export type ConversationType =
  | "public_channel"
  | "private_channel"
  | "im"
  | "mpim"
  | "group"
  | "room"
  | "supergroup"
  | "channel"
  | "unknown";

export type ChannelFacts = {
  surface: JoinSurface;
  externalId: string;
  conversationType: ConversationType;
  isPrivate: boolean | null;
  isShared: boolean | null;
  isExtShared: boolean | null;
  isIm: boolean;
  isMpim: boolean;
  memberCount: number | null;
  internalMembers: number | null;
  externalMembers: number | null;
  guestMembers: number | null;
  /** Every member was inspected (Slack only; LINE / Telegram cannot list members). */
  membersComplete: boolean;
  /** Internal Slack user ids (bounded) — only for parties.upsert proposals. */
  internalMemberIds: string[];
};

/** Facts the bot cannot verify (LINE / Telegram events, or Slack unreachable). */
export function unverifiedFacts(ref: ChannelRef, conversationType: ConversationType = "unknown", memberCount: number | null = null): ChannelFacts {
  return {
    surface: ref.surface,
    externalId: ref.externalId,
    conversationType,
    isPrivate: null,
    isShared: null,
    isExtShared: null,
    isIm: conversationType === "im",
    isMpim: conversationType === "mpim",
    memberCount,
    internalMembers: null,
    externalMembers: null,
    guestMembers: null,
    membersComplete: false,
    internalMemberIds: [],
  };
}

/** Material facts only (sharing flags + who is present), not counts or member ids. */
export function channelFactsHash(f: ChannelFacts): string {
  const canonical = JSON.stringify([
    f.surface,
    f.externalId,
    f.conversationType,
    f.isPrivate,
    f.isShared,
    f.isExtShared,
    f.isIm,
    f.isMpim,
    f.membersComplete,
    f.internalMembers === null ? null : f.internalMembers > 0,
    f.externalMembers === null ? null : f.externalMembers > 0,
    f.guestMembers === null ? null : f.guestMembers > 0,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export type ClassificationSuggestion = {
  classification: ChannelClassification;
  mixed: boolean;
  basis: "verified_internal" | "external_present" | "unverified";
};

export function suggestClassification(f: ChannelFacts): ClassificationSuggestion {
  if (f.isExtShared === true || (f.externalMembers ?? 0) > 0 || (f.guestMembers ?? 0) > 0) {
    return { classification: "shared_external", mixed: true, basis: "external_present" };
  }
  if (
    f.surface === "slack" &&
    f.membersComplete &&
    f.isExtShared === false &&
    f.externalMembers === 0 &&
    f.guestMembers === 0
  ) {
    return { classification: "internal", mixed: false, basis: "verified_internal" };
  }
  // Cannot verify → the safe side for egress (same as today's unregistered = external).
  return { classification: "shared_external", mixed: true, basis: "unverified" };
}

function yesNo(value: boolean | null): string {
  return value === null ? "不明" : value ? "あり" : "なし";
}

/** One line for the approval card / notices: Connect, privacy, guests, external members. */
export function describeSharingJa(f: ChannelFacts): string {
  const parts: string[] = [];
  if (f.surface === "slack") {
    parts.push(`Slack Connect（社外共有）: ${yesNo(f.isExtShared)}`);
    if (f.isPrivate !== null) parts.push(`非公開: ${f.isPrivate ? "はい" : "いいえ"}`);
  } else {
    parts.push(`${surfaceLabel(f.surface)} ${f.conversationType === "room" ? "トークルーム" : "グループ"}`);
  }
  if (f.guestMembers === null && f.externalMembers === null) {
    parts.push("メンバー構成: 確認できません（Bot から一覧を取得できない）");
  } else {
    parts.push(`ゲスト: ${f.guestMembers ?? "不明"}名`);
    parts.push(`社外メンバー: ${f.externalMembers ?? "不明"}名`);
    parts.push(f.membersComplete ? "全員確認済み" : "一部のみ確認");
  }
  return parts.join(" / ");
}

// ---------------------------------------------------------------- tickets
export type ProposedTicket = {
  tool: "channels.classify" | "parties.upsert";
  key: string;
  args: Record<string, unknown>;
};

export type ChannelProposal = {
  skip?: "im_not_proposed";
  suggestion: ClassificationSuggestion;
  classify: ProposedTicket;
  parties: ProposedTicket[];
  partiesTruncated: boolean;
};

export function channelProposalKey(ref: { surface: string; externalId: string }): string {
  return `channel:${ref.surface}:${ref.externalId}`;
}

export function buildChannelProposal(
  facts: ChannelFacts,
  opts: { registeredPartyIds: Set<string>; maxParties: number }
): ChannelProposal {
  const suggestion = suggestClassification(facts);
  const classify: ProposedTicket = {
    tool: "channels.classify",
    key: channelProposalKey(facts),
    args: {
      surface: facts.surface,
      externalId: facts.externalId,
      classification: suggestion.classification,
      mixed: suggestion.mixed,
    },
  };
  if (facts.isIm) {
    // 1:1 DMs: channels.classify without employeeId would remove the IM route;
    // DM routes have their own flow (SLACK_DM_AUTOROUTE / dmAutoroute.*).
    return { skip: "im_not_proposed", suggestion, classify, parties: [], partiesTruncated: false };
  }
  const candidates =
    suggestion.mixed && facts.surface === "slack"
      ? facts.internalMemberIds.filter((id) => !opts.registeredPartyIds.has(id))
      : [];
  const parties = candidates.slice(0, Math.max(0, opts.maxParties)).map((id) => ({
    tool: "parties.upsert" as const,
    key: `party:slack_user:${id}`,
    args: { kind: "slack_user", identifier: id, audience: "internal" },
  }));
  return { suggestion, classify, parties, partiesTruncated: candidates.length > parties.length };
}

// ---------------------------------------------------------------- wording
export type ProposalState = "created" | "pending" | "decided" | "not_proposed" | "flag_off" | "error";

export function classifyExample(ref: { surface: string; externalId: string }) {
  return {
    name: "channels.classify",
    arguments: { surface: ref.surface, externalId: ref.externalId, classification: "internal", mixed: false },
  };
}

export function buildUnregisteredDenyNoticeJa(input: {
  ref: { surface: string; externalId: string };
  reason: string;
  approvalId?: string | null;
  proposalState?: ProposalState;
}): string {
  const where = `${surfaceLabel(input.ref.surface)} ${input.ref.externalId}`;
  const lines = [
    `⚠️ Staffpass: 未登録チャネルへの投稿を止めました（${where}）`,
    `理由: ${input.reason} — このチャネルは分類が未登録のため社外扱いになり、機密区分の投稿は拒否されます。本文は含めていません。`,
  ];
  if (input.approvalId && (input.proposalState === undefined || input.proposalState === "created" || input.proposalState === "pending")) {
    lines.push(`対処: 承認窓口に届いている分類チケット（channels.classify）をワンタップで承認すると登録されます（承認ID: ${input.approvalId}）。社外と共有されているなら却下してください。`);
  } else if (input.approvalId && input.proposalState === "decided") {
    lines.push(`分類チケットは処理済みです（承認ID: ${input.approvalId}）。変える場合は管理エージェントで channels.classify を依頼してください。`);
  } else {
    lines.push(`対処: 管理エージェントで channels.classify（surface=${input.ref.surface}, externalId=${input.ref.externalId}）を依頼し、承認してください。`);
  }
  return lines.join("\n");
}
