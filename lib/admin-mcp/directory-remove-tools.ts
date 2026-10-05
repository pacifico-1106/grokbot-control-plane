/**
 * Admin MCP: remove one row from the org's channel ledger (org_channels) or
 * party ledger (org_parties).
 *
 *   channels.remove  always_human (ticket → delete on fulfillment)
 *   parties.remove   always_human (ticket → delete on fulfillment)
 *
 * Both require ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED (default OFF). The
 * tools are always in the registry; with the flag OFF they answer
 * `directory_remove_tools_disabled` (request) and refuse at fulfillment too.
 *
 * Security invariants (tests in directory-remove-tools.test.ts):
 * - orgId ALWAYS comes from the admin credential (request) / the approval row
 *   (fulfillment). No orgId argument; unknown arguments are rejected.
 * - Another org's row gets the same not-found as a missing id; no ticket.
 * - Deleting a classification is fail-safe: an unregistered channel / party
 *   falls back to the party ledger / internal-audience rule and otherwise to
 *   external (validateReplyRecipient fail_closed_unknown_recipient).
 * - Slack IM (D…): the DM ingress route is deleted BEFORE the channel row (same
 *   order as channels.classify / config-change channel_remove). If the route
 *   delete fails, the channel row is kept.
 * - slack_user party: its auto DM routes (SLACK_DM_AUTOROUTE_ENABLED) are
 *   removed BEFORE the party row; any failure keeps the party
 *   (dm_route_remove_failed).
 * - Fulfillment re-reads the row by id in the approval's org with a strict
 *   lookup (a DB error is an error, never "already removed"). Already gone →
 *   ok no-op; a row re-created later (new id) is never touched.
 * - A delete never makes the gateway judge the destination LESS restrictive
 *   (external / mixed / guest / outside-domain → internal): the post-delete
 *   audience is computed at request AND at fulfillment
 *   (directory-remove-audience.ts) → directory_remove_relaxes_audience.
 * - Rows are selected by what channels.list / parties.list return
 *   (surface + externalId / kind + identifier; the lists carry no row ids).
 *   channelId / partyId stay accepted.
 */
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import {
  afterRemoveCardLine,
  channelAudienceAfterRemove,
  DIRECTORY_REMOVE_AUDIENCE_CHECK_FAILED,
  partyAudienceAfterRemove,
  relaxRefusal,
  removeRelaxesAudience,
  type AudienceAfterRemove,
} from "@/lib/admin-mcp/directory-remove-audience";
import { CHANNEL_LEDGER_SURFACES } from "@/lib/channel-classify/core";
import { rejectUnsafeArgs } from "@/lib/admin-mcp/slack-dm-setup";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  deleteOrgChannel,
  deleteOrgParty,
  getOrgChannel,
  getOrgParty,
  listOrgChannels,
  listOrgParties,
} from "@/lib/data/directory";
import {
  deleteSlackImEmployeeRoute,
  getSlackImEmployeeRoute,
  isSlackImChannelId,
} from "@/lib/data/slack-im-routes";
import { isDemoMode } from "@/lib/mode";
import { removeAutoDmRoutesForCounterpart } from "@/lib/slack/dm-autoroute";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { McpToolDef } from "@/lib/mcp/tools";
import type {
  ApprovalRequest,
  ChannelClassification,
  ChannelLedgerSurface,
  OrgChannel,
  OrgParty,
  OrgPartyKind,
} from "@/lib/types";

export const CHANNELS_REMOVE_TOOL = "channels.remove";
export const PARTIES_REMOVE_TOOL = "parties.remove";
export const DIRECTORY_REMOVE_TOOLS = [CHANNELS_REMOVE_TOOL, PARTIES_REMOVE_TOOL] as const;
export type DirectoryRemoveTool = (typeof DIRECTORY_REMOVE_TOOLS)[number];

export function isDirectoryRemoveTool(name: string): name is DirectoryRemoveTool {
  return (DIRECTORY_REMOVE_TOOLS as readonly string[]).includes(name);
}

export const DIRECTORY_REMOVE_TOOLS_FLAG = "ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/** ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED (default OFF). */
export function isAdminMcpDirectoryRemoveToolsEnabled(): boolean {
  return parseFlag(process.env[DIRECTORY_REMOVE_TOOLS_FLAG]);
}

/** org_channels.surface (incl. telegram since #276). */
const SURFACES: readonly ChannelLedgerSurface[] = CHANNEL_LEDGER_SURFACES;
const PARTY_KINDS: readonly OrgPartyKind[] = [
  "email_domain",
  "slack_channel",
  "slack_user",
  "phone",
  "line",
  "mail_address",
];
const ROW_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLASSIFICATION_JA: Record<ChannelClassification, string> = {
  internal: "社内",
  shared_external: "社外共有",
  unknown: "未分類",
};
const PARTY_KIND_JA: Record<OrgPartyKind, string> = {
  email_domain: "メールドメイン",
  slack_channel: "Slack チャネル",
  slack_user: "Slack ユーザー",
  phone: "電話",
  line: "LINE",
  mail_address: "メールアドレス",
};

const CHANNEL_FAIL_SAFE_JA =
  "削除後このチャネルは未登録になり、返信先は相手台帳・社内判定ルールで判定されます。どれにも当てはまらなければ社外扱い（承認が必要）になります。";
const PARTY_FAIL_SAFE_JA =
  "削除後この相手は未登録になり、社内判定ルールに当てはまらなければ社外扱い（承認が必要）になります。";

export const CHANNELS_REMOVE_TOOL_DEF: McpToolDef = {
  name: CHANNELS_REMOVE_TOOL,
  description:
    "Remove one channel from this org's channel ledger (org_channels) after human approval (always_human, approvalClass admin; requires ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED, otherwise directory_remove_tools_disabled). Select the row by externalId + surface exactly as channels.list returns them (surface default slack; channels.list carries no row ids), or by channelId (ledger row id) when you already have it. The row must belong to this org (from the credential; no orgId argument); a missing row or another org's row → channel_not_found (no ticket). The approval card shows the external ID, current classification / mixed flag and how the channel will be judged after the delete. A delete that would turn an external / mixed / unknown channel internal (e.g. an internal slack_channel party would take over) is refused with directory_remove_relaxes_audience (no ticket; re-checked at fulfillment) — change the classification explicitly with channels.classify instead. For a Slack 1:1 DM (D…) its DM ingress route is removed first; if that fails nothing is deleted. Applied only when a human approves, re-checked then (already gone → ok no-op; a channel re-classified later is not touched), recorded in the admin change log (admin.channel, op remove). Admin cannot self-approve. Re-invoke with approvalId to read the result.",
  inputSchema: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel ledger row id (not returned by channels.list; use externalId + surface from channels.list instead)" },
      externalId: { type: "string", description: "Channel external ID as returned by channels.list (e.g. Slack C…/G…/D…, Telegram chat id), used when channelId is omitted" },
      surface: { type: "string", enum: [...SURFACES], description: "Surface of externalId as returned by channels.list (default slack)" },
      jobId: { type: "string" },
      approvalId: { type: "string", description: "Re-invoke with approved ticket ID" },
    },
    additionalProperties: false,
  },
};

export const PARTIES_REMOVE_TOOL_DEF: McpToolDef = {
  name: PARTIES_REMOVE_TOOL,
  description:
    "Remove one party from this org's party ledger (org_parties) after human approval (always_human, approvalClass admin; requires ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED, otherwise directory_remove_tools_disabled). Select the row by kind + identifier exactly as parties.list returns them (parties.list carries no row ids), or by partyId when you already have it. The row must belong to this org (from the credential; no orgId argument); a missing row or another org's row → party_not_found (no ticket). The approval card shows kind, identifier, current audience and how the destination will be judged after the delete. A delete that would turn an external party internal (a guest of the own Slack workspace with auto-internal teams, an address inside an internal email domain / internal email_domain party, an external domain the org rule lists as internal) is refused with directory_remove_relaxes_audience (no ticket; re-checked at fulfillment) — use parties.upsert to change the audience explicitly instead. For a slack_user party its auto-created 1:1 DM routes (SLACK_DM_AUTOROUTE_ENABLED) are removed first; if that fails the party is kept (dm_route_remove_failed). Applied only when a human approves, re-checked then (already gone → ok no-op), recorded in the admin change log (admin.parties, op remove). Admin cannot self-approve. Re-invoke with approvalId to read the result.",
  inputSchema: {
    type: "object",
    properties: {
      partyId: { type: "string", description: "Party ledger row id (not returned by parties.list; use kind + identifier from parties.list instead)" },
      kind: { type: "string", enum: [...PARTY_KINDS], description: "Party kind, used with identifier when partyId is omitted" },
      identifier: { type: "string", description: "Party identifier (e.g. Slack U…, example.co.jp)" },
      jobId: { type: "string" },
      approvalId: { type: "string", description: "Re-invoke with approved ticket ID" },
    },
    additionalProperties: false,
  },
};

const ALLOWED_ARGS: Record<DirectoryRemoveTool, readonly string[]> = {
  [CHANNELS_REMOVE_TOOL]: ["channelId", "externalId", "surface", "jobId", "approvalId"],
  [PARTIES_REMOVE_TOOL]: ["partyId", "kind", "identifier", "jobId", "approvalId"],
};

const DISABLED_NEXT_STEP_JA =
  "運営が ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED を ON にするまでは使えません。チャネルなら、社員証側の staffpass_config_change_request（kind=channel_remove、人の承認つき）でも外せます。";

export type DirectoryRemoveToolOutcome =
  | { kind: "result"; data: Record<string, unknown>; isError?: boolean }
  | {
      kind: "queue";
      queuedArgs: Record<string, unknown>;
      summary: string;
      title: string;
    };

function fail(code: string, message: string, extra: Record<string, unknown> = {}): DirectoryRemoveToolOutcome {
  return { kind: "result", data: { ok: false, code, message, ...extra }, isError: true };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// --- dependencies (overridable in tests to observe order / inject failures) ---

type Deps = {
  deleteSlackImEmployeeRoute: typeof deleteSlackImEmployeeRoute;
  deleteOrgChannel: typeof deleteOrgChannel;
  deleteOrgParty: typeof deleteOrgParty;
  removeAutoDmRoutesForCounterpart: typeof removeAutoDmRoutesForCounterpart;
};

const REAL_DEPS: Deps = {
  deleteSlackImEmployeeRoute,
  deleteOrgChannel,
  deleteOrgParty,
  removeAutoDmRoutesForCounterpart,
};
let depsOverride: Partial<Deps> | null = null;

/** Test-only: override deletion dependencies (null restores the real ones). */
export function setDirectoryRemoveDepsForTests(overrides: Partial<Deps> | null): void {
  depsOverride = overrides;
}

function deps(): Deps {
  return { ...REAL_DEPS, ...(depsOverride ?? {}) };
}

// --- strict, org-scoped lookups (a DB error throws; never reads as "gone") ---

function mapChannel(row: Record<string, unknown>): OrgChannel {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    surface: String(row.surface) as ChannelLedgerSurface,
    externalId: String(row.external_id),
    classification: String(row.classification || "unknown") as ChannelClassification,
    mixed: row.mixed === true,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapParty(row: Record<string, unknown>): OrgParty {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: String(row.kind) as OrgPartyKind,
    identifier: String(row.identifier),
    audience: row.audience === "internal" ? "internal" : "external",
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

async function findChannelById(orgId: string, id: string): Promise<OrgChannel | null> {
  if (!orgId || !ROW_ID_RE.test(id)) return null;
  if (isDemoMode()) return (await listOrgChannels(orgId)).find((row) => row.id === id && row.orgId === orgId) ?? null;
  if (!UUID_RE.test(id)) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_channels")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("channel_lookup_failed");
  return data ? mapChannel(data as Record<string, unknown>) : null;
}

async function findPartyById(orgId: string, id: string): Promise<OrgParty | null> {
  if (!orgId || !ROW_ID_RE.test(id)) return null;
  if (isDemoMode()) return (await listOrgParties(orgId)).find((row) => row.id === id && row.orgId === orgId) ?? null;
  if (!UUID_RE.test(id)) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_parties")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("party_lookup_failed");
  return data ? mapParty(data as Record<string, unknown>) : null;
}

// --- approval cards (separate from the checks) ---

export function buildChannelRemoveCard(channel: OrgChannel, imRouteEmployeeId: string | null, after?: AudienceAfterRemove): string {
  const cls = `${CLASSIFICATION_JA[channel.classification] ?? channel.classification}${channel.mixed ? "・混在" : ""}`;
  const lines = [
    `チャネル台帳から削除します: ${channel.surface} ${channel.externalId}（現在の分類: ${cls}）。`,
    ...(after ? [afterRemoveCardLine(after)] : []),
    CHANNEL_FAIL_SAFE_JA,
  ];
  if (channel.surface === "slack" && isSlackImChannelId(channel.externalId)) {
    lines.push(
      imRouteEmployeeId
        ? `1:1 DM の受信ルート（AI社員 ${imRouteEmployeeId}）を先に削除します。以後この DM は AI社員に届きません。`
        : "1:1 DM の受信ルートがあれば先に削除します。"
    );
  }
  return lines.join("\n");
}

export function buildPartyRemoveCard(party: OrgParty, after?: AudienceAfterRemove): string {
  const lines = [
    `相手台帳から削除します: ${PARTY_KIND_JA[party.kind] ?? party.kind} ${party.identifier}（現在: ${party.audience === "internal" ? "社内" : "社外"}）。`,
    ...(after ? [afterRemoveCardLine(after)] : []),
    PARTY_FAIL_SAFE_JA,
  ];
  if (party.kind === "slack_user") {
    lines.push("この相手との 1:1 DM 自動ルート（自動で作ったもの）があれば先に外します。外せなければ削除しません。");
  }
  return lines.join("\n");
}

// --- request side ---

export async function handleDirectoryRemoveTool(
  name: DirectoryRemoveTool,
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<DirectoryRemoveToolOutcome> {
  if (!isAdminMcpDirectoryRemoveToolsEnabled()) {
    return fail(
      "directory_remove_tools_disabled",
      `${DIRECTORY_REMOVE_TOOLS_FLAG} が OFF です（運営が ON にしてから使えます）。`,
      { nextStepJa: DISABLED_NEXT_STEP_JA }
    );
  }
  const unsafe = rejectUnsafeArgs(args, ALLOWED_ARGS[name]);
  if (unsafe) return unsafe as DirectoryRemoveToolOutcome;
  const orgId = cred.orgId;
  return name === CHANNELS_REMOVE_TOOL ? requestChannelRemove(orgId, args) : requestPartyRemove(orgId, args);
}

async function requestChannelRemove(orgId: string, args: Record<string, unknown>): Promise<DirectoryRemoveToolOutcome> {
  const channelId = str(args.channelId);
  const externalId = str(args.externalId);
  const surfaceRaw = str(args.surface) || "slack";
  if (!channelId && !externalId) return fail("missing_required_fields", "channelId か externalId が必要です");
  if (!(SURFACES as readonly string[]).includes(surfaceRaw)) {
    return fail("invalid_surface", `surface は ${SURFACES.join(" / ")} のいずれかです`);
  }
  const surface = surfaceRaw as ChannelLedgerSurface;
  let channel: OrgChannel | null;
  try {
    channel = channelId ? await findChannelById(orgId, channelId) : await getOrgChannel(orgId, surface, externalId);
  } catch {
    return fail("channel_lookup_failed", "チャネル台帳を読めませんでした。少し待ってからやり直してください。");
  }
  if (channel && channelId && externalId && (channel.externalId !== externalId || channel.surface !== surface)) {
    channel = null;
  }
  if (!channel || channel.orgId !== orgId) {
    return fail("channel_not_found", "このテナントのチャネル台帳に見つかりません");
  }
  let after: AudienceAfterRemove;
  try {
    after = await channelAudienceAfterRemove(orgId, channel);
  } catch {
    return fail(DIRECTORY_REMOVE_AUDIENCE_CHECK_FAILED, "削除後の判定を確認できませんでした（台帳を読めませんでした）。", {
      retryable: true,
      nextStepJa: "少し待ってから、もう一度依頼してください。",
    });
  }
  if (removeRelaxesAudience(after)) {
    const refusal = relaxRefusal(CHANNELS_REMOVE_TOOL, `チャネル ${channel.externalId}`, after);
    return fail(refusal.code, refusal.messageJa, refusal);
  }
  const isIm = channel.surface === "slack" && isSlackImChannelId(channel.externalId);
  const route = isIm ? await getSlackImEmployeeRoute(orgId, channel.externalId) : null;
  return {
    kind: "queue",
    title: "チャネル台帳から削除",
    summary: buildChannelRemoveCard(channel, route?.employeeId ?? null, after),
    queuedArgs: {
      channelId: channel.id,
      surface: channel.surface,
      externalId: channel.externalId,
      before: { classification: channel.classification, mixed: channel.mixed },
      slackIm: isIm,
    },
  };
}

async function requestPartyRemove(orgId: string, args: Record<string, unknown>): Promise<DirectoryRemoveToolOutcome> {
  const partyId = str(args.partyId);
  const kindRaw = str(args.kind);
  const identifier = str(args.identifier);
  if (!partyId && !(kindRaw && identifier)) return fail("missing_required_fields", "partyId か kind + identifier が必要です");
  if (kindRaw && !(PARTY_KINDS as readonly string[]).includes(kindRaw)) {
    return fail("invalid_party_kind", `kind は ${PARTY_KINDS.join(" / ")} のいずれかです`);
  }
  let party: OrgParty | null;
  try {
    party = partyId ? await findPartyById(orgId, partyId) : await getOrgParty(orgId, kindRaw as OrgPartyKind, identifier);
  } catch {
    return fail("party_lookup_failed", "相手台帳を読めませんでした。少し待ってからやり直してください。");
  }
  if (party && partyId && kindRaw && party.kind !== kindRaw) party = null;
  if (!party || party.orgId !== orgId) {
    return fail("party_not_found", "このテナントの相手台帳に見つかりません");
  }
  let after: AudienceAfterRemove;
  try {
    after = await partyAudienceAfterRemove(orgId, party);
  } catch {
    return fail(DIRECTORY_REMOVE_AUDIENCE_CHECK_FAILED, "削除後の判定を確認できませんでした（台帳・社内判定ルールを読めませんでした）。", {
      retryable: true,
      nextStepJa: "少し待ってから、もう一度依頼してください。",
    });
  }
  if (removeRelaxesAudience(after)) {
    const refusal = relaxRefusal(PARTIES_REMOVE_TOOL, `${PARTY_KIND_JA[party.kind] ?? party.kind} ${party.identifier}`, after, party.kind);
    return fail(refusal.code, refusal.messageJa, refusal);
  }
  return {
    kind: "queue",
    title: "相手台帳から削除",
    summary: buildPartyRemoveCard(party, after),
    queuedArgs: {
      partyId: party.id,
      kind: party.kind,
      identifier: party.identifier,
      before: { audience: party.audience },
    },
  };
}

// --- fulfillment (after human approval) ---

export type DirectoryRemoveFulfillment =
  | { ok: true; id: string; summaryJa: string; alreadyRemoved: boolean }
  | { ok: false; code: string; messageJa: string; nextStepJa?: string; retryable?: boolean };

const DISABLED_AT_FULFIL: DirectoryRemoveFulfillment = {
  ok: false,
  code: "directory_remove_tools_disabled",
  messageJa: `${DIRECTORY_REMOVE_TOOLS_FLAG} が OFF のため削除しませんでした。`,
};

/** Fulfillment-time post-delete audience check; null = may delete. */
async function recheckAfterRemove(
  compute: () => Promise<AudienceAfterRemove>,
  subject: string,
  tool: DirectoryRemoveTool,
  kind?: OrgPartyKind
): Promise<DirectoryRemoveFulfillment | null> {
  let after: AudienceAfterRemove;
  try {
    after = await compute();
  } catch {
    return {
      ok: false,
      code: DIRECTORY_REMOVE_AUDIENCE_CHECK_FAILED,
      messageJa: "削除後の判定を確認できなかったため、削除しませんでした。",
      nextStepJa: "少し待ってから、もう一度依頼してください。",
      retryable: true,
    };
  }
  if (!removeRelaxesAudience(after)) return null;
  const refusal = relaxRefusal(tool, subject, after, kind);
  return {
    ok: false,
    code: refusal.code,
    messageJa: `承認後に台帳・社内判定ルールが変わりました。${refusal.messageJa}`,
    nextStepJa: refusal.nextStepJa,
    retryable: false,
  };
}

export async function fulfillChannelRemove(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<DirectoryRemoveFulfillment> {
  if (!isAdminMcpDirectoryRemoveToolsEnabled()) return DISABLED_AT_FULFIL;
  const orgId = approval.orgId;
  const channelId = str(args.channelId);
  if (!channelId) return { ok: false, code: "invalid_payload", messageJa: "チケットにチャネルの ID がありません。" };
  const current = await findChannelById(orgId, channelId);
  if (!current) {
    return { ok: true, id: channelId, alreadyRemoved: true, summaryJa: "このチャネルはすでに削除済みでした（変更なし）。" };
  }
  // Re-check with the state at approval time (the row / parties may have changed).
  const gate = await recheckAfterRemove(() => channelAudienceAfterRemove(orgId, current), `チャネル ${current.externalId}`, CHANNELS_REMOVE_TOOL);
  if (gate) return gate;
  const d = deps();
  const isIm = current.surface === "slack" && isSlackImChannelId(current.externalId);
  let routeEmployeeId: string | null = null;
  if (isIm) {
    routeEmployeeId = (await getSlackImEmployeeRoute(orgId, current.externalId))?.employeeId ?? null;
    // Route first: throws → nothing deleted (fail-closed, retry possible).
    await d.deleteSlackImEmployeeRoute({ orgId, slackChannelId: current.externalId });
  }
  const removed = await d.deleteOrgChannel(orgId, current.id);
  if (!removed || (await findChannelById(orgId, current.id))) {
    return { ok: false, code: "channel_delete_failed", messageJa: "チャネル台帳から削除できませんでした。" };
  }
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.channel",
    purpose: "admin.channel",
    summary: `チャネル台帳から削除: ${current.externalId}`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      op: "remove",
      channelId: current.id,
      surface: current.surface,
      externalId: current.externalId,
      before: { classification: current.classification, mixed: current.mixed },
      slackImRouteRemoved: isIm,
      slackImRouteEmployeeId: routeEmployeeId,
      approvedBy: approval.resolvedBy ?? null,
    },
  });
  return {
    ok: true,
    id: current.id,
    alreadyRemoved: false,
    summaryJa: `チャネル台帳から ${current.externalId} を削除しました${isIm ? "（1:1 DM の受信ルートも削除）" : ""}。以後は未登録として判定されます。`,
  };
}

export async function fulfillPartyRemove(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<DirectoryRemoveFulfillment> {
  if (!isAdminMcpDirectoryRemoveToolsEnabled()) return DISABLED_AT_FULFIL;
  const orgId = approval.orgId;
  const partyId = str(args.partyId);
  if (!partyId) return { ok: false, code: "invalid_payload", messageJa: "チケットに相手の ID がありません。" };
  const current = await findPartyById(orgId, partyId);
  if (!current) {
    return { ok: true, id: partyId, alreadyRemoved: true, summaryJa: "この相手はすでに削除済みでした（変更なし）。" };
  }
  const gate = await recheckAfterRemove(
    () => partyAudienceAfterRemove(orgId, current),
    `${PARTY_KIND_JA[current.kind] ?? current.kind} ${current.identifier}`,
    PARTIES_REMOVE_TOOL,
    current.kind
  );
  if (gate) return gate;
  const d = deps();
  let dmAutoroute: { status: string; removed: number } | null = null;
  if (current.kind === "slack_user") {
    const result = await d.removeAutoDmRoutesForCounterpart({ orgId, counterpartSlackUserId: current.identifier });
    const failed = result.status === "error" || result.items.some((item) => item.outcome === "failed");
    if (failed) {
      return {
        ok: false,
        code: "dm_route_remove_failed",
        messageJa: "この相手との 1:1 DM 自動ルートを外せなかったため、相手台帳から削除しませんでした。",
      };
    }
    dmAutoroute = { status: result.status, removed: result.items.filter((item) => item.outcome === "removed").length };
  }
  const removed = await d.deleteOrgParty(orgId, current.id);
  if (!removed || (await findPartyById(orgId, current.id))) {
    return { ok: false, code: "party_delete_failed", messageJa: "相手台帳から削除できませんでした。" };
  }
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.parties",
    purpose: "admin.parties",
    summary: `相手台帳から削除: ${current.identifier}`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      op: "remove",
      partyId: current.id,
      kind: current.kind,
      identifier: current.identifier,
      before: { audience: current.audience },
      dmAutoroute,
      approvedBy: approval.resolvedBy ?? null,
    },
  });
  return {
    ok: true,
    id: current.id,
    alreadyRemoved: false,
    summaryJa: `相手台帳から ${current.identifier} を削除しました。以後は未登録として判定されます。`,
  };
}
