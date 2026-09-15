/**
 * F7 audience ledger 補完 — egress_denied + unknown audience の 1 回自動再試行。
 * parties / internal_audience_rule / org_channels 台帳から宛先を補完し、ゲート再評価で invoke を再実行。
 * 補完失敗 → config_drift + W4 通知（ループしない）。
 */
import { appendAuditEvent } from "@/lib/data";
import {
  getOrgChannel,
  getOrgParty,
  listOrgChannels,
  listOrgParties,
  upsertOrgChannel,
} from "@/lib/data/directory";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import {
  parseConversationContext,
  resolveAudience,
} from "@/lib/gateway/audience";
import { prepareOpsFaultRetryInvokeBody } from "@/lib/stuck-watch/retry-eligibility";
import { notifyStuckWatchMouth } from "@/lib/stuck-watch/notify-mouth";
import type {
  ConversationContext,
  EgressVerdict,
  GatewayInvokeRequest,
} from "@/lib/types";

export type AudienceLedgerEgress = {
  audience?: string;
  effectiveAudience?: string;
  reason?: string;
};

/** Whether egress_denied is due to missing / unknown audience (補完候補). */
export function isEgressDeniedAudienceMissing(
  egress: AudienceLedgerEgress | null | undefined
): boolean {
  const audience = egress?.audience || egress?.effectiveAudience || "";
  return !audience || audience === "unknown" || audience === "external";
}

/** Org has parties, internal channels, or internal_audience_rule configured. */
export async function orgHasInternalAudienceLedger(
  orgId: string
): Promise<boolean> {
  const parties = await listOrgParties(orgId);
  if (parties.length > 0) return true;

  const channels = await listOrgChannels(orgId);
  if (
    channels.some(
      (row) => row.classification === "internal" || row.classification === "shared_external"
    )
  ) {
    return true;
  }

  const rule = await getOrgInternalAudienceRule(orgId);
  if (rule.emailDomains.length > 0) return true;
  if (rule.autoSlackTeamInternal && rule.slackTeamIds.length > 0) return true;

  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Enrich invoke body conversation from parties / internal_audience_rule ledger.
 * - Sync channel classification from parties.upsert (unknown → internal)
 * - Infer slackTeamId from org rule when unambiguous
 * - Merge args destination fields into conversation
 */
export async function supplementInvokeBodyFromLedger(
  orgId: string,
  body: GatewayInvokeRequest
): Promise<GatewayInvokeRequest> {
  const args = asRecord(body.args);
  const conv: Partial<ConversationContext> = {
    ...asRecord(body.conversation),
  };

  if (!conv.slackChannelId && args.slackChannelId) {
    conv.slackChannelId = String(args.slackChannelId);
  }
  if (!conv.slackChannelId && args.channel) {
    conv.slackChannelId = String(args.channel);
  }
  if (!conv.slackChannelId && body.slackChannelId) {
    conv.slackChannelId = String(body.slackChannelId);
  }
  if (!conv.slackUserId && args.slackUserId) {
    conv.slackUserId = String(args.slackUserId);
  }
  if (!conv.slackUserId && args.userId) {
    conv.slackUserId = String(args.userId);
  }
  if (!conv.slackUserId && body.slackUserId) {
    conv.slackUserId = String(body.slackUserId);
  }
  if (!conv.slackTeamId && args.slackTeamId) {
    conv.slackTeamId = String(args.slackTeamId);
  }
  if (!conv.slackTeamId && args.teamId) {
    conv.slackTeamId = String(args.teamId);
  }
  if (!conv.email && args.email) {
    conv.email = String(args.email);
  }
  if (!conv.email && args.to) {
    conv.email = String(args.to);
  }
  if (!conv.orgId) {
    conv.orgId = orgId;
  }
  if (!conv.surface) {
    if (conv.slackChannelId || conv.slackUserId) conv.surface = "slack";
    else if (conv.email) conv.surface = "mail";
    else if (conv.phone) conv.surface = "phone";
    else if (conv.lineId) conv.surface = "line";
  }

  const rule = await getOrgInternalAudienceRule(orgId);
  if (
    !conv.slackTeamId &&
    rule.autoSlackTeamInternal &&
    rule.slackTeamIds.length === 1
  ) {
    conv.slackTeamId = rule.slackTeamIds[0];
  }

  const channelId = conv.slackChannelId;
  if (channelId && conv.surface === "slack") {
    const party = await getOrgParty(orgId, "slack_channel", channelId);
    if (party?.audience === "internal") {
      const channel = await getOrgChannel(orgId, "slack", channelId);
      if (!channel || channel.classification !== "internal") {
        await upsertOrgChannel({
          orgId,
          surface: "slack",
          externalId: channelId,
          classification: "internal",
          mixed: false,
          skipInspect: true,
        });
      }
    }
  }

  return {
    ...body,
    conversation: conv,
  };
}

export type AudienceLedgerRetryInput = {
  orgId: string;
  employeeId: string;
  credentialId?: string | null;
  body: GatewayInvokeRequest;
  egress: EgressVerdict | AudienceLedgerEgress | null;
  tool: string;
  purpose: string;
  jobId: string;
  /** When true, skip policy.inferInternalAudienceFromLedger check (manual Admin retry). */
  force?: boolean;
};

export type AudienceLedgerRetryResult = {
  attempted: boolean;
  skippedReason?: string;
  supplemented?: boolean;
  resolvedAudience?: string;
  invokeResult?: { httpStatus: number; body: Record<string, unknown> };
};

export type RunInvokeFn = (input: {
  employeeId: string;
  credentialId?: string | null;
  body: GatewayInvokeRequest;
}) => Promise<{ httpStatus: number; body: Record<string, unknown> }>;

/**
 * One audience ledger 補完 attempt: enrich body, re-resolve audience, retry invoke with gates re-evaluated.
 * Returns null when补完 is not applicable (caller returns original egress_denied).
 */
export async function attemptAudienceLedgerRetry(
  input: AudienceLedgerRetryInput,
  runInvoke: RunInvokeFn
): Promise<AudienceLedgerRetryResult> {
  const supplementedFlag = input.body._audienceLedgerSupplemented === true;
  if (supplementedFlag) {
    return { attempted: false, skippedReason: "already_supplemented" };
  }

  if (!isEgressDeniedAudienceMissing(input.egress)) {
    return { attempted: false, skippedReason: "audience_not_missing" };
  }

  const policy = await getOrgStuckWatchPolicy(input.orgId);
  if (!input.force && !policy.inferInternalAudienceFromLedger) {
    return { attempted: false, skippedReason: "policy_disabled" };
  }

  const hasLedger = await orgHasInternalAudienceLedger(input.orgId);
  if (!hasLedger) {
    return { attempted: false, skippedReason: "no_ledger" };
  }

  const supplementedBody = await supplementInvokeBodyFromLedger(
    input.orgId,
    input.body
  );
  const ctx = parseConversationContext(supplementedBody, input.orgId);
  const resolved = await resolveAudience(ctx, { requireDestination: true });
  const resolvedAudience = resolved.audience;

  const retryBody = prepareOpsFaultRetryInvokeBody({
    ...supplementedBody,
    _audienceLedgerSupplemented: true,
  });

  const invokeResult = await runInvoke({
    employeeId: input.employeeId,
    credentialId: input.credentialId,
    body: retryBody,
  });

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: input.credentialId ?? null,
    action: "stuck_watch.audience_ledger_retry",
    purpose: input.purpose,
    summary: invokeResult.body.ok
      ? "audience台帳補完後の invoke 再試行（成功）"
      : "audience台帳補完後の invoke 再試行（未解決）",
    metadata: {
      tool: input.tool,
      jobId: input.jobId,
      resolvedAudience,
      supplemented: true,
      httpStatus: invokeResult.httpStatus,
      ok: invokeResult.body.ok,
      code: invokeResult.body.code,
      faultClass: invokeResult.body.faultClass,
    },
  }).catch(() => undefined);

  return {
    attempted: true,
    supplemented: true,
    resolvedAudience,
    invokeResult,
  };
}

export type ConfigDriftW4Input = {
  orgId: string;
  employeeId: string | null;
  tool: string;
  jobId: string;
  purpose: string;
  code: string;
  egress?: AudienceLedgerEgress | null;
  itemId?: string;
};

/** W4: config_drift 通知のみ（補完失敗後）。 */
export async function notifyConfigDriftW4(
  input: ConfigDriftW4Input
): Promise<{ ok: boolean; skipped?: boolean }> {
  const policy = await getOrgStuckWatchPolicy(input.orgId);
  const audience =
    input.egress?.audience || input.egress?.effectiveAudience || "unknown";
  const message = [
    "⚠️ Staffpass Stuck Watch W4 (config_drift)",
    `egress_denied: audience台帳補完後も解決できませんでした`,
    `tool=${input.tool} jobId=${input.jobId}`,
    `audience=${audience} code=${input.code}`,
    `employeeId=${input.employeeId || "—"}`,
    "parties.upsert / internalAudienceRule.patch / channels.classify を確認してください。",
  ].join("\n");

  const mouth = await notifyStuckWatchMouth(input.orgId, policy, message, {
    kind: "w4_config_drift",
    faultClass: "config_drift",
    tool: input.tool,
    jobId: input.jobId,
    itemId: input.itemId,
    code: input.code,
    audience,
  });

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: null,
    action: "stuck_watch.w4_notify",
    purpose: input.purpose || "stuck_watch",
    summary: `W4 config_drift: audience台帳補完失敗 (${input.tool})`,
    metadata: {
      kind: "w4_config_drift",
      faultClass: "config_drift",
      tool: input.tool,
      jobId: input.jobId,
      itemId: input.itemId,
      code: input.code,
      audience,
      notifyMouth: policy.notifyMouth,
      mouthDelivered: mouth.ok && !mouth.skipped,
      mouthSkipped: mouth.skipped,
      mouthError: mouth.error,
      nextAction: "fix_ledger",
    },
  }).catch(() => undefined);

  return { ok: mouth.ok || Boolean(mouth.skipped) };
}

/**
 * After a failed audience ledger retry, reclassify response as config_drift and fire W4.
 */
export async function finalizeAudienceLedgerFailure(
  input: ConfigDriftW4Input,
  body: Record<string, unknown>,
  httpStatus: number
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  await notifyConfigDriftW4(input);
  return {
    httpStatus,
    body: {
      ...body,
      faultClass: "config_drift",
      stuckHint: "fix",
      hasInternalLedger: true,
      audienceLedgerSupplementAttempted: true,
      audienceLedgerSupplementFailed: true,
    },
  };
}
