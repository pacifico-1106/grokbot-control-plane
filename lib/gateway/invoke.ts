import {
  buildApprovalArtifact,
  buildApprovalTitle,
  buildRichApprovalSummary,
  formatArtifactLines,
  inferRiskForTool,
} from "@/lib/approvals/summary";
import { PROVIDER_RATE_LIMITED, RETRY_AFTER_DEFAULT_SECONDS, rateLimitedBody } from "@/lib/gateway/adapters/rate-limit";
import { sendApprovalNeededEmail } from "@/lib/email";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  assertExecutable,
  appendAuditEvent,
  createApproval,
  getActionCounts,
  getApprovalById,
  getBinding,
  getEmployee,
  getEmployeeById,
  runtimeModeLabel,
  incrementActionCounter,
  getOrgSodWarnPolicy,
  updateApprovalMetadata,
} from "@/lib/data";
import { evaluateMailPolicyForRequest } from "@/lib/mail-policy/evaluate-request";
import { collectMailToRecipients, extractMailRecipients } from "@/lib/mail-policy/apply";
import { buildMailSendPin, checkApprovedMailSendPin } from "@/lib/mail-policy/approved-send-pin";
import type { MailPolicyDecision } from "@/lib/types";
import {
  isBillableConfirmCompletion,
  recordGatedConfirmAction,
} from "@/lib/billing/meter";
import { assertBillingAllowsGateway } from "@/lib/billing/entitlements";
import { evaluateDualEgress } from "@/lib/gateway/egress";
import {
  parseConversationContext,
  resolveAudience,
  resolveConversationThreadId,
  resolveParentMessageTs,
} from "@/lib/gateway/audience";
import { lookupWakeParent, consumeWakeParent } from "@/lib/data/wake-parent-stash";
import {
  isSlackDmReplyInlineEnabled,
  isSlackDmReplyTarget,
  resolveSlackDmInlineThreadTs,
} from "@/lib/slack/dm-reply-inline";
import { getEffectiveReplyPolicy } from "@/lib/data/reply-policy";
import { resolveInformationDisclosure } from "@/lib/gateway/information-class";
import { evaluateProjectScope } from "@/lib/gateway/project-scope";
import { accessibleProjects } from "@/lib/employees/project-access";
import {
  employeeHasToolScope,
  isAudienceGatedTool,
  isConfirmClassTool,
  isOutboundSendTool,
  isSnsPublishTool,
  toolRequiresHumanApproval,
  resolveGatewayTool,
} from "@/lib/gateway/tools";
import {
  looksLikeSlackTs,
  postConversationMessage,
  SLACK_TOKEN_MISSING,
  validateSlackPostDestination,
} from "@/lib/gateway/adapters/slack";
import {
  validateReplyRecipient,
  decideReplyDestination,
} from "@/lib/gateway/reply-recipient-validate";
import {
  evaluateFileAttachmentEgress,
  uploadSlackFile,
  buildFileUploadAuditPayload,
  buildFileUploadSuccess,
  buildFileUploadEgressDenied,
  buildFileUploadFailed,
  buildFileUploadSkipped,
  fileUploadFailureSendState,
  type FileUploadResponse,
} from "@/lib/gateway/adapters/slack-file-upload";
import { parseSnsSurface, publishSnsPost, type SnsPublishResult } from "@/lib/gateway/adapters/sns";
import {
  buildInvokeSnapshot,
  fulfillApprovedInvoke,
  conversationDeliveryFromFulfillment,
  snsDeliveryFromFulfillment,
  parseFulfillment,
  parseInvokeSnapshot,
  type ConversationDelivery,
} from "@/lib/approvals/fulfill";
import { approvedRerunConversationDelivery } from "@/lib/approvals/approved-rerun-delivery";
import {
  auditLegacySnapshotAttachmentBlock,
  deliverApprovedRerunAttachment,
  legacySnapshotAttachmentBlock,
} from "@/lib/approvals/approved-rerun-attachment";
import { isDemoMode } from "@/lib/mode";
import { evaluateAllowedAccountsForBrowser } from "@/lib/employees/allowed-accounts";
import { evaluateSpend } from "@/lib/spend-gate";
import { evaluateActionLimit } from "@/lib/action-gate";
import { evaluateSod } from "@/lib/employees/sod";
import {
  VOICE_FORBIDDEN_CODE,
  VOICE_FORBIDDEN_MESSAGE_JA,
  effectiveVoice,
  findForbiddenPhrase,
  outboundConversationText,
} from "@/lib/employees/voice";
import {
  attemptAudienceLedgerRetry,
  finalizeAudienceLedgerFailure,
  orgHasInternalAudienceLedger,
} from "@/lib/stuck-watch/audience-ledger";
import { enrichInvokeFailureBody } from "@/lib/stuck-watch/enrich";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import type { DualEgressVerdict, Employee, EgressVerdict, GatewayInvokeRequest } from "@/lib/types";
import { createHash } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { runCommDeleteInvoke } from "@/lib/comm-delete/invoke";
import { buildSlackPostRecord } from "@/lib/comm-delete/post-record";
import {
  CrossProductEventError,
  normalizeCommerceAuthorization,
} from "@/lib/commerce/cross-product-events";
import {
  detectSecretInPayload,
  buildSecretDetectionErrorResponse,
} from "@/lib/security/secret-detector";
import {
  isCommReplyDedupEnabled,
  isDuplicateGuardV2Enabled,
  isGoogleCalendarReadEnabled,
  isTopicGatedPostingEnabled,
} from "@/lib/feature-flags";
import { checkTopicGate, buildTopicGateApprovalMetadata } from "@/lib/decision-workflow/topic-gate";
import { getOrgApprovalKindRoutesPolicy } from "@/lib/approval-kind-routes/data";
import { getToolApprovalKind } from "@/lib/approval-kind-routes/tool-kind-map";
import {
  addCompletedReaction,
  addWaitingApprovalReaction,
} from "@/lib/slack/reaction-stamps";
import { assertGatewayToolAllowedForPlan } from "@/lib/billing/plan-gate";
import { readCalendarFreebusy } from "@/lib/google/calendar-read";
import {
  auditCrossEmployee,
  auditDedupUnavailable,
  auditDuplicateSuppressed,
  auditPostOutcomeUnknown,
  claimDirectCommReplySend,
  confirmedNotDeliveredRef,
  dedupStopBody,
  duplicateWarningBody,
  finishDirectCommReplySend,
  ledgerOutcomeAfterPost,
  postOutcomeUnknownBody,
  precheckCommReplyDuplicate,
  prepareCommReplyDedupFromBody,
  prepareFileUploadDedup,
  prepareSnsPublishDedup,
  releaseConfirmedUncertain,
  releaseConfirmedUncertainForScope,
  supersedeOlderOnNewApproval,
  type DedupAuditCtx,
  type DirectSendClaim,
  type GuardCheck,
  type GuardDuplicate,
  type PreparedCommReplyDedup,
} from "@/lib/comm-reply-dedup/guard";
import { expireStaleConversationApprovals } from "@/lib/comm-reply-dedup/approvals";
import {
  addCalendarReadGrant,
  revokeCalendarReadGrant,
} from "@/lib/data/google-identities";
import {
  applySchedulingPolicyToPropose,
  type ProposeInput,
} from "@/lib/scheduling-policy/propose";
import { egressDenyNextStep, onEgressDenied } from "@/lib/channel-classify/deny-hook";

/** PR-B: informational nextStep (channels.classify) on an external-treated deny. */
function denyNextStepFields(body: GatewayInvokeRequest, egress: { decision?: string; reason?: string; audience?: string }) {
  const next = egressDenyNextStep(body, egress);
  return next ? { nextStep: next, nextStepJa: next.messageJa } : {};
}

export type GatewayInvokeResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

function jsonResult(
  body: Record<string, unknown>,
  httpStatus = 200
): GatewayInvokeResult {
  const enriched =
    body.ok === false || httpStatus >= 400
      ? enrichInvokeFailureBody(body, httpStatus)
      : body;
  return { httpStatus, body: enriched };
}

/**
 * Validate mail.send required fields for approval judgment material.
 * Fail-closed: missing to/subject/body → 400 (not needs_approval).
 */
function validateMailSendArtifact(body: GatewayInvokeRequest): {
  ok: true;
  to: string;
  subject: string;
  bodyText: string;
  from?: string;
} | {
  ok: false;
  missing: string[];
  code: string;
  messageJa: string;
} {
  const args = body.args && typeof body.args === "object"
    ? (body.args as Record<string, unknown>)
    : {};

  // Fail-closed: a recipient field we cannot read (array / object / number)
  // must not be skipped in favour of the next field.
  const unreadableRecipientFields = (["to", "recipient", "email"] as const).filter(
    (key) => args[key] !== undefined && args[key] !== null && typeof args[key] !== "string"
  );
  if (unreadableRecipientFields.length > 0) {
    return {
      ok: false,
      missing: [],
      code: "mail_recipient_invalid",
      messageJa: `宛先は文字列で指定してください（複数宛先はカンマ区切り）。不正な項目: ${unreadableRecipientFields.join(", ")}`,
    };
  }

  const to = (
    typeof args.to === "string" ? args.to :
    typeof args.recipient === "string" ? args.recipient :
    typeof args.email === "string" ? args.email :
    typeof body.email === "string" ? body.email :
    body.conversation?.email ?? ""
  ).trim();

  const subject = (
    typeof args.subject === "string" ? args.subject :
    typeof args.title === "string" ? args.title :
    ""
  ).trim();

  const bodyText = (
    typeof args.body === "string" ? args.body :
    typeof args.text === "string" ? args.text :
    typeof args.message === "string" ? args.message :
    typeof args.content === "string" ? args.content :
    ""
  ).trim();

  const from = (
    typeof args.from === "string" ? args.from :
    typeof args.sender === "string" ? args.sender :
    ""
  ).trim() || undefined;

  const missing: string[] = [];
  if (!to) missing.push("to");
  if (!subject) missing.push("subject");
  if (!bodyText) missing.push("body");

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      code: "mail_send_missing_fields",
      messageJa: `メール送信には宛先・件名・本文が必須です。不足: ${missing.join(", ")}`,
    };
  }

  return { ok: true, to, subject, bodyText, from };
}

/**
 * P1: Extract content for topic gate check.
 * Combines message text, attachments, and metadata into a single string.
 */
function extractContentForTopicGate(body: GatewayInvokeRequest): string {
  const args = body.args && typeof body.args === "object"
    ? (body.args as Record<string, unknown>)
    : {};

  const parts: string[] = [];

  const text = (
    typeof args.text === "string" ? args.text :
    typeof args.message === "string" ? args.message :
    typeof args.body === "string" ? args.body :
    typeof args.content === "string" ? args.content :
    ""
  ).trim();
  if (text) parts.push(text);

  const subject = (
    typeof args.subject === "string" ? args.subject :
    typeof args.title === "string" ? args.title :
    ""
  ).trim();
  if (subject) parts.push(subject);

  const attachments = args.attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (typeof att === "string") {
        parts.push(att);
      } else if (att && typeof att === "object") {
        const filename = (att as Record<string, unknown>).filename ||
          (att as Record<string, unknown>).name || "";
        if (typeof filename === "string" && filename) {
          parts.push(filename);
        }
      }
    }
  }

  return parts.join(" ");
}

/**
 * P1: Extract channel ID for topic gate check.
 */
function extractChannelIdForTopicGate(body: GatewayInvokeRequest): string | null {
  const args = body.args && typeof body.args === "object"
    ? (body.args as Record<string, unknown>)
    : {};

  const channelId = (
    typeof args.channelId === "string" ? args.channelId :
    typeof args.channel_id === "string" ? args.channel_id :
    typeof args.channel === "string" ? args.channel :
    body.slackChannelId ??
    body.conversation?.slackChannelId ??
    null
  );

  return channelId && typeof channelId === "string" ? channelId : null;
}

/**
 * S2: Evaluate invoke egress with dual-audience support.
 * Returns both the effective verdict (external-safe for behavior) and
 * the dual verdict (for audit when channelMixed).
 */
async function evaluateInvokeEgress(input: {
  orgId: string;
  tool: string;
  toolDef: import("@/lib/gateway/tools").GatewayToolDef;
  body: import("@/lib/types").GatewayInvokeRequest;
}): Promise<{
  egress: EgressVerdict | null;
  dualEgress: DualEgressVerdict | null;
}> {
  const gated = isAudienceGatedTool(input.toolDef);
  const ctx = parseConversationContext(input.body, input.orgId);
  if (!gated && !ctx) return { egress: null, dualEgress: null };

  const audience = await resolveAudience(ctx, { requireDestination: gated });
  const disclosure = await resolveInformationDisclosure({
    orgId: input.orgId,
    tool: input.tool,
    body: input.body,
    audience: audience.audience,
  });

  const dualEgress = evaluateDualEgress({
    audience: audience.audience,
    dualAudience: audience.dualAudience,
    informationClass: disclosure.informationClass,
    fidelity: disclosure.fidelity,
    namedRecipients: audience.namedRecipients,
  });

  return {
    egress: dualEgress.effectiveDecision,
    dualEgress,
  };
}

/**
 * Fail-closed tool invoke (P0 contract) — shared by Gateway HTTP + remote MCP.
 * - purpose + jobId (or job_id) required
 * - unregistered tools rejected
 * - confirm / send / order default needs_approval; per-tool hints can loosen mail.send / calendar.confirm / commerce.order / files.write / browser.use
 * - browser.use: allowedAccounts missing/mismatch → fail-closed (C5)
 * - AgentMail tools are reserved (P0.5) — no live send
 * MCP must call this path; never a softer MCP-only branch.
 */

async function createNeedsApprovalResponse(opts: {
  employeeId: string;
  orgId: string;
  credentialId: string | null;
  employeeDisplayName: string;
  employee?: Employee | null;
  tool: string;
  purpose: string;
  jobId: string;
  risk?: "low" | "medium" | "high";
  amountJpy?: number | null;
  message: string;
  extra?: Record<string, unknown>;
  httpStatus?: number;
  parentApprovalId?: string | null;
  metadata?: Record<string, unknown>;
  summaryPrefix?: string;
  body?: GatewayInvokeRequest;
  egress?: EgressVerdict | null;
  mailPolicy?: MailPolicyDecision | null;
}) {
  const risk = opts.risk || inferRiskForTool(opts.tool);
  const title = buildApprovalTitle(opts.tool, opts.purpose);
  const conversation = opts.body
    ? parseConversationContext(opts.body, opts.orgId)
    : null;
  const artifact = buildApprovalArtifact(
    opts.tool,
    opts.body,
    opts.egress ?? null,
    conversation
  );
  if (opts.mailPolicy && (opts.tool === "mail.send" || opts.tool === "mail.draft")) {
    artifact.sendMode = opts.mailPolicy.sendMode;
    const recipients = opts.body ? extractMailRecipients(opts.body) : { hasAttachments: false };
    if (recipients.hasAttachments) artifact.hasAttachments = true;
  }
  const invokeSnapshot = buildInvokeSnapshot({
    tool: opts.tool,
    purpose: opts.purpose,
    jobId: opts.jobId,
    employeeId: opts.employeeId,
    orgId: opts.orgId,
    employee: opts.employee,
    body: opts.body,
    conversation,
    informationClass: opts.egress?.informationClass,
    fidelity: opts.egress?.fidelity,
  });
  // The approved attachment is NOT a summary line (#253 follow-up 5): every
  // surface renders it on its own from the snapshot (lib/approvals/attachment-card.ts),
  // so it cannot be confused with "添付ファイル:" text inside the message body.
  const extraLines = formatArtifactLines(artifact);
  const baseSummary = buildRichApprovalSummary({
    tool: opts.tool,
    purpose: opts.purpose,
    jobId: opts.jobId,
    employeeDisplayName: opts.employeeDisplayName,
    amountJpy: opts.amountJpy,
    risk,
    extraLines,
  });
  const summary = opts.summaryPrefix
    ? `${opts.summaryPrefix}\n\n${baseSummary}`
    : baseSummary;

  let approvalId: string | null = null;
  let statusToken: string | null = null;
  let pollUrl: string | null = null;
  let pollPath: string | null = null;
  let demoStore: string | null = null;
  let createdApproval: Awaited<ReturnType<typeof createApproval>>["approval"] | null = null;

  try {
    const created = await createApproval({
      orgId: opts.orgId,
      employeeId: opts.employeeId,
      credentialId: opts.credentialId || opts.employeeId,
      title,
      purpose: opts.purpose,
      summary,
      risk,
      tool: opts.tool,
      jobId: opts.jobId,
      parentApprovalId: opts.parentApprovalId,
      metadata: {
        ...(opts.metadata ?? {}),
        artifact,
        invoke: invokeSnapshot,
        // mail.send: pin the exact approved content (digests only) so an
        // approved re-invoke cannot change recipients / subject / body.
        // Set last so nothing earlier in metadata can supply it.
        ...(opts.tool === "mail.send"
          ? { mailSendPin: opts.body ? buildMailSendPin(opts.body) : undefined }
          : {}),
      },
    });
    createdApproval = created.approval;
    approvalId = created.approval.id;
    statusToken = created.statusToken;
    pollUrl = created.pollUrl;
    pollPath = created.approval.pollPath;
    demoStore = created.demoStore ?? null;
  } catch (e) {
    // Still return needs_approval so Bot stops; ticket create failure is surfaced.
    const errMsg = e instanceof Error ? e.message : "approval_create_failed";
    return jsonResult(
      {
        ok: false,
        code: "needs_approval",
        error: "needs_approval",
        message: opts.message,
        needs_approval: true,
        approvalCreateError: errMsg,
        employeeId: opts.employeeId,
        tool: opts.tool,
        purpose: opts.purpose,
        jobId: opts.jobId,
        summary,
        title,
        pollHint: "continue_polling",
        ...opts.extra,
      },
      opts.httpStatus ?? 402
    );
  }

  // COMM_REPLY_DEDUP_ENABLED: the newer approval request replaces older pending
  // ones for the same conversation (same employee). Best effort, audited.
  if (createdApproval && opts.body && isAudienceGatedTool(opts.tool)) {
    const preparedForSupersede = prepareCommReplyDedupFromBody({
      orgId: opts.orgId,
      employeeId: opts.employeeId,
      body: opts.body,
      text: conversationOutboundText(opts.body, opts.purpose),
    });
    await supersedeOlderOnNewApproval(preparedForSupersede, createdApproval.id);
  }

  // Best-effort human notify (Resend stub in DEMO).
  const notifyTo =
    process.env.BILLING_NOTIFY_EMAIL ||
    process.env.APPROVAL_NOTIFY_EMAIL ||
    "owner@example.com";
  void sendApprovalNeededEmail(notifyTo, summary, risk).catch(() => null);
  const channelNotifications = createdApproval
    ? await sendApprovalNotifications(createdApproval, opts.employee ?? null).catch(
        (error) => [{
          ok: false,
          provider: "unknown" as const,
          error: error instanceof Error ? error.message : "channel_notify_failed",
        }]
      )
    : [];

  // Add :hourglass_flowing_sand: reaction on original message to indicate waiting for approval (flag-gated, best-effort)
  if (
    conversation?.surface === "slack" &&
    conversation.slackChannelId &&
    (conversation.ts || conversation.messageTs || conversation.slackTs)
  ) {
    const originalTs = conversation.ts || conversation.messageTs || conversation.slackTs || "";
    if (looksLikeSlackTs(originalTs)) {
      void addWaitingApprovalReaction({
        orgId: opts.orgId,
        employeeId: opts.employeeId,
        postingAs: opts.employee?.postingAs || "bot",
        channel: conversation.slackChannelId,
        timestamp: originalTs,
      }).catch(() => undefined);
    }
  }

  return jsonResult(
    {
      ok: false,
      code: "needs_approval",
      error: "needs_approval",
      message: opts.message,
      needs_approval: true,
      approvalId,
      statusToken,
      pollUrl,
      pollPath,
      pollHint: "continue_polling",
      title,
      summary,
      risk,
      employeeId: opts.employeeId,
      tool: opts.tool,
      purpose: opts.purpose,
      jobId: opts.jobId,
      demoStore,
      // Backward-compatible field retained for existing bot clients.
      telegramNotified: channelNotifications.some(
        (result) => result.provider === "telegram" && result.ok
      ),
      notificationResults: channelNotifications,
      ...opts.extra,
    },
    opts.httpStatus ?? 402
  );
}

/** The text a conversation tool posts (same rule as the post and the approval fulfill). */
function conversationOutboundText(body: GatewayInvokeRequest, purpose: string): string {
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  const raw = [args.text, args.body, args.message].find((value) => typeof value === "string" && value.trim());
  return (typeof raw === "string" ? raw : "").trim() || purpose;
}

/**
 * Duplicate / unavailable check → the response to return (nothing is posted);
 * null = go ahead. Audited here (hashes only). Every stop carries code /
 * reasonCode, nextAction and nextStep (lib/comm-reply-dedup/guard.ts).
 */
async function directSendDedupResponse(
  claim: DirectSendClaim | GuardCheck,
  prepared: PreparedCommReplyDedup,
  ctx: { orgId: string; employeeId: string; credentialId: string | null; purpose: string; tool: string; jobId: string }
) {
  const auditCtx: DedupAuditCtx = { ...ctx, phase: "invoke" };
  const stop = dedupStopBody(claim, prepared);
  if (!stop) return null;
  if (claim.state === "unavailable") await auditDedupUnavailable(auditCtx, claim.reason);
  else if (claim.state === "duplicate" && prepared.kind === "ready") {
    await auditDuplicateSuppressed(auditCtx, prepared, claim as GuardDuplicate);
  }
  return jsonResult(
    {
      ...stop.body,
      needs_approval: false,
      employeeId: ctx.employeeId,
      tool: ctx.tool,
      purpose: ctx.purpose,
      jobId: ctx.jobId,
    },
    stop.status
  );
}

export type RunGatewayInvokeInput = {
  employeeId: string;
  body: GatewayInvokeRequest;
  /** Optional credential id from Bearer resolution */
  credentialId?: string | null;
};

/**
 * Core Gateway enforcement. Callers must already resolve employeeId from an
 * authenticated source (Bearer 社員証, or server-side admin/session context).
 * Never pass an unauthenticated client-supplied id (e.g. x-employee-id).
 */
export async function runGatewayInvoke(
  input: RunGatewayInvokeInput
): Promise<GatewayInvokeResult> {
  const body = input.body;
  const employeeId = (input.employeeId || "").trim();

  if (!employeeId) {
    return jsonResult(
      {
        ok: false,
        code: "unbound",
        error: "employee_id_required",
        message: "employeeId required; refuse invoke (fail-closed)",
      },
      401
    );
  }

  const purpose = (body.purpose || "").trim();
  const jobId = (body.jobId || body.job_id || "").trim();
  const toolRaw = (body.tool || "").trim();

  if (!purpose) {
    return jsonResult(

      {
        ok: false,
        code: "purpose_required",
        error: "purpose_required",
        message: "purpose is required on gateway invoke (fail-closed)",
      },
      400
    );
  }

  if (!jobId) {
    return jsonResult(

      {
        ok: false,
        code: "job_id_required",
        error: "job_id_required",
        message: "jobId (or job_id) is required on gateway invoke (fail-closed)",
      },
      400
    );
  }

  if (!toolRaw) {
    return jsonResult(

      {
        ok: false,
        code: "tool_required",
        error: "tool_required",
        message: "tool is required; unregistered tools are rejected",
      },
      400
    );
  }

  // P0-A: Secret-in-chat detector (fail-closed, before any data logging)
  // Chat NEVER: passwords, refresh tokens, API keys, full employee/admin badge secrets
  const secretDetection = detectSecretInPayload(body);
  if (!secretDetection.ok) {
    return jsonResult(
      {
        ...buildSecretDetectionErrorResponse(secretDetection),
        employeeId,
        tool: toolRaw,
        purpose,
        jobId,
      },
      400
    );
  }

  const resolved = resolveGatewayTool(toolRaw);
  if (!resolved.ok) {
    return jsonResult(

      {
        ok: false,
        code: "unknown_tool",
        error: "unknown_tool",
        tool: resolved.tool || toolRaw,
        message:
          "unregistered tool rejected (fail-closed). Use allowlisted tools only (e.g. calendar.propose / calendar.confirm, mail.draft / mail.send).",
      },
      403
    );
  }

  const toolDef = resolved.def;
  const tool = toolDef.id;

  const decision = await assertExecutable(employeeId);
  if (!decision.ok) {
    const status =
      decision.code === "not_found" || decision.code === "unbound"
        ? 401
        : 403;
    return jsonResult(
      {
        ok: false,
        code: decision.code,
        error: decision.code,
        message: decision.message,
        binding: (await getBinding(employeeId)) ?? null,
        purpose,
        jobId,
        tool,
      },
      status
    );
  }

  // Bot invokes carry a 社員証 but no browser session.
  // Prefer session org, else binding.orgId, else admin PK lookup.
  const binding = await getBinding(employeeId);
  const orgId =
    (await getCurrentOrgId()) || binding?.orgId || decision.binding.orgId || null;
  let employee = await getEmployee(employeeId, orgId);
  if (!employee) {
    employee = await getEmployeeById(employeeId);
  }

  if (!employee) {
    return jsonResult(

      {
        ok: false,
        code: "not_found",
        error: "employee_not_found",
        message: "employee not found",
        purpose,
        jobId,
        tool,
      },
      401
    );
  }

  const billingGate = await assertBillingAllowsGateway(orgId || employee.orgId, tool);
  if (!billingGate.ok) {
    return jsonResult(
      {
        ok: false,
        code: billingGate.code,
        error: billingGate.code,
        tool,
        message: `トライアル期間が終了したため、${tool} はご利用いただけません。プランを選択してお手続きください。`,
        billingPath: "/app/billing",
        entitlements: {
          plan: billingGate.entitlements.plan,
          status: billingGate.entitlements.status,
          canHire: billingGate.entitlements.canHire,
          expiredTrial: billingGate.entitlements.expiredTrial,
        },
        employeeId,
        purpose,
        jobId,
      },
      402
    );
  }

  // P1 Plan Rails: check if tool is available for org's plan (flag-gated)
  const planGate = await assertGatewayToolAllowedForPlan(orgId || employee.orgId, tool);
  if (!planGate.ok) {
    return jsonResult(
      {
        ok: false,
        code: planGate.code,
        error: planGate.code,
        tool,
        message: planGate.messageJa,
        planKey: planGate.planKey,
        billingStatus: planGate.billingStatus,
        availableInPlans: planGate.availableInPlans,
        billingPath: "/app/billing",
        employeeId,
        purpose,
        jobId,
      },
      403
    );
  }

  const parentApprovalId = (body.parentApprovalId || "").trim();
  if (parentApprovalId) {
    const parent = await getApprovalById(
      parentApprovalId,
      orgId || employee.orgId
    );
    if (
      !parent ||
      parent.status !== "revision_requested" ||
      parent.employeeId !== employeeId ||
      parent.jobId !== jobId
    ) {
      return jsonResult(
        {
          ok: false,
          code: "invalid_parent_approval",
          error: "invalid_parent_approval",
          message:
            "parentApprovalId must reference a revision_requested approval for the same employee and jobId",
          employeeId,
          tool,
          purpose,
          jobId,
        },
        400
      );
    }
  }

  const invokeMetadata: Record<string, unknown> = {};
  const artifactUrl = body.args?.artifact_url ?? body.args?.artifactUrl;
  if (typeof artifactUrl === "string" && artifactUrl.trim()) {
    invokeMetadata.artifact_url = artifactUrl.trim();
  }
  let commerceAuthorization: ReturnType<
    typeof normalizeCommerceAuthorization
  > | null = null;
  if (tool === "commerce.order" && body.commerceAuthorization) {
    try {
      commerceAuthorization = normalizeCommerceAuthorization({
        value: body.commerceAuthorization,
        purpose,
        amountJpy: Number(body.amountJpy),
      });
    } catch (error) {
      if (error instanceof CrossProductEventError) {
        return jsonResult(
          {
            ok: false,
            code: error.code,
            error: error.code,
            message: "Sealith向けJPYC購入承認の拘束条件が不正です",
            employeeId,
            tool,
            purpose,
            jobId,
          },
          error.status,
        );
      }
      throw error;
    }
    invokeMetadata.crossProductCommerce = {
      targetSystem: "sealith",
      authorityMode: "external_reference",
      credentialGeneration: decision.binding.credentialGeneration,
      authorization: commerceAuthorization,
    };
  }
  if (tool === "commerce.order") {
    invokeMetadata.approvedAmountJpy = Number(body.amountJpy);
  }
  if (tool === "calendar.allowlist.patch") {
    const args = (body.args || {}) as Record<string, unknown>;
    const allowlistArgs = {
      action: typeof args.action === "string" ? args.action : "add",
      calendarId: typeof args.calendarId === "string" ? args.calendarId : "",
      grantId: typeof args.grantId === "string" ? args.grantId : "",
      label: typeof args.label === "string" ? args.label : "",
      targetEmployeeId: typeof args.employeeId === "string" ? args.employeeId : null,
    };
    const canonical = JSON.stringify(allowlistArgs);
    invokeMetadata.calendarAllowlistArgs = allowlistArgs;
    invokeMetadata.calendarAllowlistArgsHash = createHash("sha256").update(canonical).digest("hex");
  }

  if (
    employee.allowedPurposes?.length &&
    !employee.allowedPurposes.includes(purpose)
  ) {
    return jsonResult(

      {
        ok: false,
        code: "purpose_denied",
        error: "purpose_not_allowed",
        message: `purpose "${purpose}" is not in credential.allowedPurposes`,
        purpose,
        jobId,
        tool,
        allowedPurposes: employee.allowedPurposes,
      },
      403
    );
  }

  if (!employeeHasToolScope(employee.scopes, toolDef)) {
    return jsonResult(

      {
        ok: false,
        code: "scope_denied",
        error: "scope_required",
        message: `tool ${tool} requires one of: ${toolDef.requiredScopes.join(", ") || "(none)"}`,
        purpose,
        jobId,
        tool,
        requiredScopes: toolDef.requiredScopes,
      },
      403
    );
  }

  const orgSodPolicy = await getOrgSodWarnPolicy(orgId || employee.orgId);
  const sodVerdict = evaluateSod(employee.scopes, orgSodPolicy);

  // P1: Topic Gate — check posts for sensitive topics behind P1_TOPIC_GATED_POSTING_ENABLED
  let topicGateResult: ReturnType<typeof checkTopicGate> | null = null;
  const toolKind = getToolApprovalKind(tool);
  if (toolKind === "post" && isTopicGatedPostingEnabled()) {
    const orgPolicy = await getOrgApprovalKindRoutesPolicy(orgId || employee.orgId);
    const topicGateConfig = orgPolicy?.topicGate ?? null;
    const contentToCheck = extractContentForTopicGate(body);
    const channelId = extractChannelIdForTopicGate(body);
    topicGateResult = checkTopicGate(contentToCheck, channelId, topicGateConfig);
    invokeMetadata.topicGateResult = topicGateResult;
  }

  // AgentMail: P0.5 reservation only — never live-send in P0.
  if (toolDef.reserved) {
    return jsonResult(

      {
        ok: false,
        code: "tool_reserved",
        error: "agentmail_p05_reserved",
        message:
          "AgentMail is schema/policy-reserved for P0.5; live send/inbox is not implemented in P0. Use mail.draft / mail.send stubs or wait for P1.",
        purpose,
        jobId,
        tool,
        layer: "agentmail",
        needs_approval: toolDef.forceNeedsApproval,
      },
      501
    );
  }

  // C5: browser.use — allowedAccounts missing/mismatch = fail-closed (not soft warn).
  // Live browser session identity remains only partially verifiable (honesty).
  let browserIdentityMeta:
    | {
        browserIdentityCheck: "partial" | "not_applicable";
        noteJa?: string;
        matchedAccount?: { service: string; accountId: string };
      }
    | undefined;
  if (tool === "browser.use") {
    const args = (body.args || {}) as Record<string, unknown>;
    const claimed = {
      service:
        body.claimedAccount?.service ||
        body.service ||
        (typeof args.service === "string" ? args.service : undefined),
      accountId:
        body.claimedAccount?.accountId ||
        body.accountId ||
        (typeof args.accountId === "string" ? args.accountId : undefined),
    };
    const accountsDecision = evaluateAllowedAccountsForBrowser({
      allowedAccounts: employee.allowedAccounts,
      claimed,
      browserRequired: true,
    });
    if (!accountsDecision.ok) {
      return jsonResult(

        {
          ok: false,
          code: accountsDecision.code,
          error: accountsDecision.code,
          message: accountsDecision.message,
          disposition: accountsDecision.disposition,
          browserIdentityCheck: accountsDecision.browserIdentityCheck,
          allowedAccounts: accountsDecision.allowedAccounts,
          claimed: accountsDecision.claimed,
          employeeId,
          tool,
          purpose,
          jobId,
          // Soft warn is not used when accounts are required / mismatched.
          needs_approval: false,
        },
      403
    );
    }
    browserIdentityMeta = {
      browserIdentityCheck: accountsDecision.browserIdentityCheck,
      noteJa: accountsDecision.noteJa,
      matchedAccount: accountsDecision.matched
        ? {
            service: accountsDecision.matched.service,
            accountId: accountsDecision.matched.accountId,
          }
        : undefined,
    };
  }

  // Prior human approval unlocks confirm-class completion (meter on success).
  // Approval button click alone is NOT billed — only Gateway success is.
  const priorApprovalId = (body.approvalId || "").trim();
  let priorApprovalOk = false;
  let priorApproval: Awaited<ReturnType<typeof getApprovalById>> = null;
  if (priorApprovalId) {
    const prior = await getApprovalById(priorApprovalId, orgId || employee.orgId);
    priorApproval = prior;
    priorApprovalOk = Boolean(
      prior &&
        prior.status === "approved" &&
        prior.employeeId === employeeId &&
        prior.credentialId === (input.credentialId || employee.credentialId) &&
        prior.tool === tool &&
        prior.jobId === jobId &&
        prior.purpose === purpose
    );
    if (priorApprovalOk && tool === "commerce.order" && prior) {
      const priorAmount = Number(prior.metadata.approvedAmountJpy);
      const priorCrossProduct = prior.metadata.crossProductCommerce ?? null;
      priorApprovalOk =
        Number.isFinite(priorAmount) &&
        priorAmount === Number(body.amountJpy) &&
        JSON.stringify(priorCrossProduct) ===
          JSON.stringify(
            commerceAuthorization
              ? {
                  targetSystem: "sealith",
                  authorityMode: "external_reference",
                  credentialGeneration: decision.binding.credentialGeneration,
                  authorization: commerceAuthorization,
                }
              : null,
          );
    }
    if (priorApprovalOk && tool === "calendar.allowlist.patch" && prior) {
      const priorArgsHash = prior.metadata.calendarAllowlistArgsHash;
      const currentArgs = (body.args || {}) as Record<string, unknown>;
      const currentAllowlistArgs = {
        action: typeof currentArgs.action === "string" ? currentArgs.action : "add",
        calendarId: typeof currentArgs.calendarId === "string" ? currentArgs.calendarId : "",
        grantId: typeof currentArgs.grantId === "string" ? currentArgs.grantId : "",
        label: typeof currentArgs.label === "string" ? currentArgs.label : "",
        targetEmployeeId: typeof currentArgs.employeeId === "string" ? currentArgs.employeeId : null,
      };
      const currentCanonical = JSON.stringify(currentAllowlistArgs);
      const currentHash = createHash("sha256").update(currentCanonical).digest("hex");
      priorApprovalOk = typeof priorArgsHash === "string" && priorArgsHash === currentHash;
    }
  }

  const actionCounts = await getActionCounts({
    orgId: orgId || employee.orgId,
    employeeId,
    tool,
  });
  const actionLimit = evaluateActionLimit({
    tool,
    limits: employee.actionLimits,
    ...actionCounts,
  });
  if (actionLimit.decision === "deny") {
    await appendAuditEvent({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      action: "action_limit.denied",
      purpose,
      summary: `${tool} を行為上限の安全停止で拒否`,
      metadata: { tool, jobId, limit: actionLimit.limit, counts: actionCounts },
    });
    return jsonResult({
      ok: false,
      code: "action_limit_denied",
      error: actionLimit.reason,
      message: actionLimit.message,
      needs_approval: false,
      actionLimit,
      employeeId,
      tool,
      purpose,
      jobId,
    }, 403);
  }

  // comm.delete: delete the employee's OWN recorded post. Own module (flag,
  // ownership by record, token of the record, idempotency, audit). Never
  // reaches the egress / posting logic below.
  if (tool === "comm.delete") {
    return runCommDeleteInvoke({
      employee,
      orgId: orgId || employee.orgId,
      credentialId: input.credentialId || employee.credentialId,
      purpose,
      jobId,
      args: (body.args || {}) as Record<string, unknown>,
      toolDef,
      priorApprovalId,
      priorApprovalOk,
      priorApproval,
      actionLimitNeedsApproval: actionLimit.decision === "needs_approval",
      json: jsonResult,
      requestApproval: (opts) =>
        createNeedsApprovalResponse({
          employeeId,
          orgId: orgId || employee.orgId,
          credentialId: input.credentialId || employee.credentialId,
          employeeDisplayName: employee.displayName,
          employee,
          tool,
          purpose,
          jobId,
          risk: opts.risk,
          message: opts.message,
          summaryPrefix: opts.summaryPrefix,
          parentApprovalId: parentApprovalId || null,
          metadata: { ...opts.metadata, actionLimit },
          body,
          extra: { ...opts.extra, actionLimit },
        }),
    });
  }

  // Project wall (WHICH) before Slack post. Deny wins over class/voice allow.
  // Internal dest does not bypass. Composed with audience × class, not a rewrite.
  const projectScope = await evaluateProjectScope({
    orgId: orgId || employee.orgId,
    employee,
    tool,
    body,
  });
  if (projectScope.denied) {
    await appendAuditEvent({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      action: "tool.invoke",
      purpose,
      summary: `${tool} をプロジェクト範囲で拒否`,
      metadata: { tool, jobId, code: projectScope.code, refs: projectScope.refs },
    });
    return jsonResult(
      {
        ok: false,
        code: projectScope.code,
        error: projectScope.code,
        message: projectScope.messageJa,
        needs_approval: false,
        projectAccess: projectScope.projectAccess,
        employeeId,
        tool,
        purpose,
        jobId,
      },
      403
    );
  }

  // Audience × information-class egress (after scope / SoD / action-limit / project wall).
  // slack.* aliases share this resolver — tool name is not the boundary.
  // S2: evaluateInvokeEgress now returns both egress (effective) and dualEgress (audit).
  const { egress, dualEgress } = await evaluateInvokeEgress({
    orgId: orgId || employee.orgId,
    tool,
    toolDef,
    body,
  });
  const managerId = employee.managerId ?? null;

  // Deny wins over SoD queue: confidential-to-external must not become a pending ticket.
  if (egress?.decision === "deny") {
    await appendAuditEvent({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      action: "tool.invoke",
      purpose,
      summary: `${tool} を相手×情報区分で拒否`,
      metadata: { tool, jobId, egress, dualEgress, managerId },
    });

    const effectiveOrgId = orgId || employee.orgId;
    const ledgerRetry = await attemptAudienceLedgerRetry(
      {
        orgId: effectiveOrgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        body,
        egress,
        tool,
        purpose,
        jobId,
      },
      runGatewayInvoke
    );

    if (ledgerRetry.attempted && ledgerRetry.invokeResult) {
      const retryCode = String(ledgerRetry.invokeResult.body.code || "");
      if (retryCode !== "egress_denied") {
        return {
          httpStatus: ledgerRetry.invokeResult.httpStatus,
          body: {
            ...ledgerRetry.invokeResult.body,
            audienceLedgerSupplementAttempted: true,
            audienceLedgerSupplementSucceeded: true,
          },
        };
      }
      if (retryCode === "egress_denied") {
        const failed = await finalizeAudienceLedgerFailure(
          {
            orgId: effectiveOrgId,
            employeeId,
            tool,
            jobId,
            purpose,
            code: retryCode,
            egress: ledgerRetry.invokeResult.body.egress as
              | { audience?: string; effectiveAudience?: string }
              | undefined,
          },
          ledgerRetry.invokeResult.body,
          ledgerRetry.invokeResult.httpStatus
        );
        return { httpStatus: failed.httpStatus, body: { ...failed.body, ...denyNextStepFields(body, egress) } };
      }
      return ledgerRetry.invokeResult;
    }

    // PR-B: unregistered channel → classification proposal + stuck notice
    // (flags OFF → no-op). Bounded, never throws; the 403 below is unchanged.
    await onEgressDenied({ orgId: effectiveOrgId, employee, body, egress });
    const stuckPolicy = await getOrgStuckWatchPolicy(effectiveOrgId);
    const hasInternalLedger =
      stuckPolicy.inferInternalAudienceFromLedger &&
      (await orgHasInternalAudienceLedger(effectiveOrgId));
    return jsonResult(
      {
        ok: false,
        code: "egress_denied",
        error: egress.reason,
        message: egress.messageJa,
        needs_approval: false,
        egress,
        dualEgress,
        managerId,
        employeeId,
        tool,
        purpose,
        jobId,
        hasInternalLedger,
        ...denyNextStepFields(body, egress),
      },
      403
    );
  }

  // Voice (HOW) after egress allow|summarize, before live Slack post.
  // calendar.read etc. are not audience-gated — no forbidden scan.
  const voice =
    isAudienceGatedTool(toolDef) && egress
      ? effectiveVoice(employee.voice, egress.effectiveAudience)
      : null;
  if (
    voice &&
    (egress?.decision === "allow" || egress?.decision === "summarize")
  ) {
    const args =
      body.args && typeof body.args === "object"
        ? (body.args as Record<string, unknown>)
        : {};
    const outbound = outboundConversationText(args);
    const phrase = outbound ? findForbiddenPhrase(outbound, voice.forbidden) : null;
    if (phrase) {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: `${tool} を社員の声の禁止語で拒否`,
        metadata: { tool, jobId, phrase, voice, egress, dualEgress, managerId },
      });
      return jsonResult(
        {
          ok: false,
          code: VOICE_FORBIDDEN_CODE,
          error: VOICE_FORBIDDEN_CODE,
          message: VOICE_FORBIDDEN_MESSAGE_JA,
          needs_approval: false,
          voice,
          egress,
          managerId,
          employeeId,
          tool,
          purpose,
          jobId,
        },
        403
      );
    }
  }

  // confirm / send / order default needs_approval unless a per-tool hint
  // loosens them. SoD warn never forces invoke. Honor employee.approvalPolicy
  // + toolApprovalDefaults + egress / spend limits only.
  const perToolHuman = toolRequiresHumanApproval(toolDef, employee.toolApprovalDefaults);
  const toolHint = employee.toolApprovalDefaults?.[toolDef.id];

  // Per-tool "deny" on any outbound-send tool (mail / Slack / conversation /
  // SNS / external share) is a hard stop: no approval card, no draft
  // demotion, and a prior approval does not reopen it (fail-closed).
  // mail.send keeps its original code for existing clients.
  if (toolHint === "deny" && isOutboundSendTool(toolDef)) {
    const deniedCode =
      tool === "mail.send" ? "mail_send_denied_by_tool_setting" : "tool_denied_by_tool_setting";
    await appendAuditEvent({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      action: "tool.invoke",
      purpose,
      summary: `${tool} をツール設定（deny）で拒否`,
      metadata: {
        tool,
        jobId,
        code: deniedCode,
        toolHint,
        ...(priorApprovalId ? { approvalId: priorApprovalId, phase: "reinvoke" } : {}),
      },
    });
    return jsonResult(
      {
        ok: false,
        code: deniedCode,
        error: deniedCode,
        message: `この社員はツール設定で ${tool} が禁止（deny）されています。`,
        needs_approval: false,
        employeeId,
        tool,
        purpose,
        jobId,
      },
      403
    );
  }
  // COMM_REPLY_DEDUP_ENABLED: the same (or a re-written) body was already sent
  // to this conversation within the window → not sent, no approval card.
  // Read-only here; the atomic claim happens right before the live post.
  // DUPLICATE_GUARD_V2_ENABLED: same jobId, channel-level, other employees,
  // short-body tier, unknown-outcome rows — and sns.publish (same ledger).
  let commReplyDedup: PreparedCommReplyDedup = { kind: "off" };
  let duplicateWarning: Record<string, unknown> | undefined;
  const snsGuarded = isSnsPublishTool(toolDef) && isDuplicateGuardV2Enabled();
  if ((isAudienceGatedTool(toolDef) || snsGuarded) && !priorApprovalOk && isCommReplyDedupEnabled()) {
    const dedupOrgId = orgId || employee.orgId;
    if (isAudienceGatedTool(toolDef)) {
      await expireStaleConversationApprovals({ orgId: dedupOrgId, employeeId, phase: "invoke" }).catch(() => []);
    }
    const dedupArgs = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
    commReplyDedup = snsGuarded
      ? prepareSnsPublishDedup({
          orgId: dedupOrgId,
          employeeId,
          surface: parseSnsSurface(dedupArgs.surface ?? dedupArgs.snsSurface ?? dedupArgs.media),
          text: conversationOutboundText(body, purpose),
          jobId,
        })
      : prepareCommReplyDedupFromBody({
          orgId: dedupOrgId,
          employeeId,
          body,
          text: conversationOutboundText(body, purpose),
        });
    const dedupCtx = {
      orgId: dedupOrgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      purpose,
      tool,
      jobId,
    };
    // (5) The AI verified that its earlier unknown-outcome post is absent: release
    // that one row (own org + employee only); a wrong ref releases nothing.
    const confirmedRef = confirmedNotDeliveredRef(body);
    if (confirmedRef) await releaseConfirmedUncertain(commReplyDedup, confirmedRef, { ...dedupCtx, phase: "invoke" });
    const pre = await precheckCommReplyDuplicate(commReplyDedup, tool);
    const stopped = await directSendDedupResponse(pre, commReplyDedup, dedupCtx);
    if (stopped) return stopped;
    if (pre.state === "none" && pre.warning && commReplyDedup.kind === "ready") {
      // (3) another employee already posted it: posted with a warning (v1, or v2 warn mode).
      await auditCrossEmployee({ ...dedupCtx, phase: "invoke" }, commReplyDedup, "warn", pre.warning);
      duplicateWarning = duplicateWarningBody(pre.warning);
    }
  }

  const amountJpy =
    tool === "commerce.order"
      ? body.amountJpy == null
        ? Number.NaN
        : Number(body.amountJpy)
      : Number.NaN;
  const spend =
    tool === "commerce.order"
      ? evaluateSpend({
          amountJpy,
          limits: employee.spend,
          approvalPolicy:
            employee.approvalPolicy === "always_human"
              ? "always_human"
              : toolHint === "auto"
                ? "auto"
                : toolHint === "risk_based"
                  ? "risk_based"
                  : perToolHuman
                    ? "always_human"
                    : employee.approvalPolicy,
          isFirstOrder: body.isFirstOrder,
          spentTodayJpy: body.spentTodayJpy,
          spentThisMonthJpy: body.spentThisMonthJpy,
        })
      : null;
  if (spend?.decision === "deny") {
    return jsonResult(
      {
        ok: false,
        code: "deny",
        error: spend.reason,
        message: spend.message,
        needs_approval: false,
        spend,
        employeeId,
        tool,
        purpose,
        jobId,
      },
      403
    );
  }

  let mailPolicyDecision: MailPolicyDecision | null = null;

  // Approved re-invoke (approvalId): re-check what was approved (the invoke
  // snapshot) plus any recipients in this request against the CURRENT mail
  // policy. If it now rejects or demotes, stop: 409, audited, not sent.
  if (tool === "mail.send" && priorApprovalOk && priorApproval) {
    // Pin first: the re-invoke must carry exactly the approved mail (every
    // recipient field, cc / bcc, subject, body and other args), or no mail
    // fields at all (= send the approved mail as-is). Approvals without a pin
    // (created before pinning) fail closed. Field names only, never values.
    const pinCheck = checkApprovedMailSendPin({ metadata: priorApproval.metadata, body });
    if (!pinCheck.ok) {
      const mismatch = pinCheck.code === "approved_send_content_mismatch" ? pinCheck : null;
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: mismatch
          ? "承認済みの mail.send を承認内容との不一致で停止（未送信）"
          : "承認済みの mail.send を照合情報なしのため停止（未送信・再承認が必要）",
        metadata: {
          tool,
          jobId,
          approvalId: priorApprovalId,
          code: pinCheck.code,
          phase: "reinvoke",
          ...(mismatch
            ? { mismatchedFields: mismatch.mismatchedFields, mismatchCount: mismatch.mismatchCount }
            : {}),
        },
      });
      return jsonResult(
        {
          ok: false,
          code: pinCheck.code,
          error: pinCheck.code,
          ...(mismatch
            ? { mismatchedFields: mismatch.mismatchedFields, mismatchCount: mismatch.mismatchCount }
            : {}),
          message: mismatch
            ? "承認された内容（宛先・CC・BCC・件名・本文など）と異なるため送信しませんでした。承認時とまったく同じ内容で再実行するか、新しい内容で承認を依頼し直してください。"
            : "この承認には内容の照合情報がないため（照合の導入前に作成された承認）、送信しませんでした。もう一度承認を依頼してください。",
          needs_approval: false,
          approvalId: priorApprovalId,
          employeeId,
          tool,
          purpose,
          jobId,
        },
        409
      );
    }
    const approvedSnapshot = parseInvokeSnapshot(priorApproval.metadata);
    const toJudge: Array<{ source: "approved_snapshot" | "request"; body: Parameters<typeof evaluateMailPolicyForRequest>[0]["body"] }> = [];
    if (approvedSnapshot) {
      toJudge.push({ source: "approved_snapshot", body: { args: approvedSnapshot.args, conversation: approvedSnapshot.conversation } });
    }
    const requestPrimary = collectMailToRecipients(body);
    const requestExtra = extractMailRecipients(body);
    const requestHasRecipients =
      requestPrimary.sources.length > 0 ||
      requestPrimary.malformed ||
      requestExtra.cc.length > 0 ||
      requestExtra.bcc.length > 0 ||
      requestExtra.malformed;
    if (!approvedSnapshot || requestHasRecipients) {
      toJudge.push({ source: "request", body });
    }
    for (const item of toJudge) {
      const { decision: recheck } = await evaluateMailPolicyForRequest({
        orgId: orgId || employee.orgId,
        employeeId,
        body: item.body,
      });
      if (!recheck.rejected && !recheck.demotedToDraft) continue;
      const blockedReason = recheck.rejected
        ? recheck.rejectCode || "mail_policy_rejected"
        : "mail_send_demoted_to_draft";
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: "承認済みの mail.send を現在のメールポリシーで停止（未送信）",
        metadata: {
          tool,
          jobId,
          approvalId: priorApprovalId,
          code: "approved_send_blocked_by_policy",
          blockedReason,
          judged: item.source,
          phase: "reinvoke",
          sendMode: recheck.sendMode,
          audience: recheck.audience,
          auditLabels: recheck.auditLabels,
          appliedRules: recheck.appliedRules,
        },
      });
      return jsonResult(
        {
          ok: false,
          code: "approved_send_blocked_by_policy",
          error: "approved_send_blocked_by_policy",
          blockedReason,
          message:
            "承認後にメールポリシーが変わり、この送信は現在の設定では許可されないため停止しました（送信していません）。",
          needs_approval: false,
          approvalId: priorApprovalId,
          employeeId,
          tool,
          purpose,
          jobId,
        },
        409
      );
    }
  }

  // B1 mail.policy: evaluate before approval gate (demote / reject / sendMode)
  if (tool === "mail.send" && !priorApprovalOk) {
    const mailValidation = validateMailSendArtifact(body);
    if (!mailValidation.ok) {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: `${tool} を判断材料不足で拒否（fail-closed）`,
        metadata: {
          tool,
          jobId,
          code: mailValidation.code,
          missing: mailValidation.missing,
        },
      });
      return jsonResult(
        {
          ok: false,
          code: mailValidation.code,
          error: mailValidation.code,
          message: mailValidation.messageJa,
          missing: mailValidation.missing,
          needs_approval: false,
          employeeId,
          tool,
          purpose,
          jobId,
        },
        400
      );
    }

    // Every primary recipient field (to / recipient / email / body.email /
    // conversation.email) is judged, not only the first non-empty one.
    const mailEval = await evaluateMailPolicyForRequest({
      orgId: orgId || employee.orgId,
      employeeId,
      body,
    });
    mailPolicyDecision = mailEval.decision;

    if (mailPolicyDecision.rejected) {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: `${tool} をメールポリシーで拒否（fail-closed）`,
        metadata: {
          tool,
          jobId,
          code: mailPolicyDecision.rejectCode,
          sendMode: mailPolicyDecision.sendMode,
          auditLabels: mailPolicyDecision.auditLabels,
          appliedRules: mailPolicyDecision.appliedRules,
        },
      });
      return jsonResult(
        {
          ok: false,
          code: mailPolicyDecision.rejectCode,
          error: mailPolicyDecision.rejectCode,
          message: mailPolicyDecision.rejectReason,
          needs_approval: false,
          employeeId,
          tool,
          purpose,
          jobId,
          mailPolicy: {
            sendMode: mailPolicyDecision.sendMode,
            audience: mailPolicyDecision.audience,
          },
        },
        403
      );
    }

    if (mailPolicyDecision.demotedToDraft) {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "tool.invoke",
        purpose,
        summary: "mail.send を mail.draft に降格（mail policy draft_only）",
        metadata: {
          tool: "mail.draft",
          originalTool: "mail.send",
          jobId,
          code: "mail_send_demoted_to_draft",
          sendMode: mailPolicyDecision.sendMode,
          audience: mailPolicyDecision.audience,
          auditLabels: mailPolicyDecision.auditLabels,
          appliedRules: mailPolicyDecision.appliedRules,
        },
      });
      return jsonResult({
        ok: true,
        code: "mail_send_demoted_to_draft",
        demoted: true,
        originalTool: "mail.send",
        tool: "mail.draft",
        sendMode: mailPolicyDecision.sendMode,
        messageJa:
          "メールポリシーにより mail.send は mail.draft に降格されました（draft_only — 実送信なし）",
        mailPolicy: {
          sendMode: mailPolicyDecision.sendMode,
          audience: mailPolicyDecision.audience,
          appliedRules: mailPolicyDecision.appliedRules,
          auditLabels: mailPolicyDecision.auditLabels,
        },
        employeeId,
        purpose,
        jobId,
        result: { drafted: true },
      });
    }
  }

  // B1 mail.policy can only tighten the gate, never loosen independent guards.
  // - needs_approval (incl. auto without consent) → force approval.
  // - auto + consent → lifts ONLY the tool-level always-human default for
  //   mail.send (no per-tool hint, or an explicit auto / risk_based hint).
  //   employee always_human, explicit always_human / deny hints, action limits,
  //   spend and topic gate still force approval (stricter side wins, fail-closed).
  const mailPolicyForceApproval =
    tool === "mail.send" && mailPolicyDecision?.needsApproval === true;
  const mailPolicyLiftsToolDefault =
    tool === "mail.send" &&
    mailPolicyDecision?.autoSend === true &&
    mailPolicyDecision.needsApproval !== true &&
    (toolHint == null || toolHint === "auto" || toolHint === "risk_based");

  // P1: Topic gate can force approval for posts with sensitive topics
  const topicGateForceApproval = topicGateResult?.requiresApproval ?? false;

  const forceApproval =
    mailPolicyForceApproval ||
    (mailPolicyLiftsToolDefault ? false : perToolHuman) ||
    employee.approvalPolicy === "always_human" ||
    actionLimit.decision === "needs_approval" ||
    spend?.decision === "needs_approval" ||
    topicGateForceApproval;

  if (
    forceApproval &&
    tool !== "tools.ping" &&
    tool !== "audit.append" &&
    !priorApprovalOk
  ) {
    if (actionLimit.decision === "needs_approval") {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "action_limit.reached",
        purpose,
        summary: `${tool} が行為上限に到達`,
        metadata: { tool, jobId, limit: actionLimit.limit, counts: actionCounts },
      });
    }
    if (topicGateForceApproval && topicGateResult) {
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "topic_gate.triggered",
        purpose,
        summary: `${tool} が機密話題を含むため承認が必要`,
        metadata: {
          tool,
          jobId,
          matchedTopics: topicGateResult.matchedTopics,
          reason: topicGateResult.reason,
        },
      });
    }
    if (tool === "commerce.order") {
      return createNeedsApprovalResponse({
        employeeId,
        orgId: orgId || employee.orgId,
        credentialId: input.credentialId || employee.credentialId,
        employeeDisplayName: employee.displayName,
        employee,
        tool,
        purpose,
        jobId,
        risk: "high",
        amountJpy: Number.isFinite(amountJpy) ? amountJpy : null,
        message: actionLimit.decision === "needs_approval" ? actionLimit.message : (spend?.message ?? "発注には人の確認が必要です"),
        parentApprovalId: parentApprovalId || null,
        metadata: { ...invokeMetadata, sodVerdict, actionLimit, egress, dualEgress, managerId },
        body,
        egress,
        extra: { spend, actionLimit, sodVerdict, egress, dualEgress, managerId, ...(voice ? { voice } : {}), toolKind: toolDef.kind, approvalPolicy: employee.approvalPolicy },
      });
    }

    return createNeedsApprovalResponse({
      employeeId,
      orgId: orgId || employee.orgId,
      credentialId: input.credentialId || employee.credentialId,
      employeeDisplayName: employee.displayName,
      employee,
      tool,
      purpose,
      jobId,
      risk: topicGateForceApproval ? "high" : inferRiskForTool(tool),
      message:
        topicGateForceApproval && topicGateResult
          ? `${tool} は機密話題（${topicGateResult.matchedTopics.join(", ")}）を含むため承認が必要です`
          : actionLimit.decision === "needs_approval"
            ? actionLimit.message
            : tool === "browser.use"
          ? `${tool} requires human approval (always_human). allowedAccounts checked; live browser identity remains partial.`
          : `${tool} requires human approval (always_human: confirm/send/order and conversation posts such as comm.reply / comm.send / slack.post)`,
      parentApprovalId: parentApprovalId || null,
      metadata: {
        ...invokeMetadata,
        sodVerdict,
        actionLimit,
        egress,
        dualEgress,
        managerId,
        ...(topicGateResult
          ? {
              topicGate: {
                matchedTopics: topicGateResult.matchedTopics,
                reason: topicGateResult.reason,
              },
            }
          : {}),
      },
      body,
      egress,
      mailPolicy: tool === "mail.send" ? mailPolicyDecision : null,
      extra: {
        toolKind: toolDef.kind,
        approvalPolicy: employee.approvalPolicy,
        sodVerdict,
        actionLimit,
        egress,
        dualEgress,
        managerId,
        ...(voice ? { voice } : {}),
        ...(mailPolicyDecision
          ? {
              mailPolicy: {
                sendMode: mailPolicyDecision.sendMode,
                audience: mailPolicyDecision.audience,
                appliedRules: mailPolicyDecision.appliedRules,
              },
            }
          : {}),
        ...(browserIdentityMeta
          ? {
              browserIdentityCheck: browserIdentityMeta.browserIdentityCheck,
              browserIdentityNoteJa: browserIdentityMeta.noteJa,
              matchedAccount: browserIdentityMeta.matchedAccount,
              allowedAccounts: employee.allowedAccounts ?? [],
            }
          : {}),
        ...(topicGateResult?.requiresApproval
          ? {
              topicGate: {
                matchedTopics: topicGateResult.matchedTopics,
                reason: topicGateResult.reason,
              },
            }
          : {}),
      },
    });
  }

  if (egress?.decision === "needs_approval" && !priorApprovalOk) {
    return createNeedsApprovalResponse({
      employeeId,
      orgId: orgId || employee.orgId,
      credentialId: input.credentialId || employee.credentialId,
      employeeDisplayName: employee.displayName,
      employee,
      tool,
      purpose,
      jobId,
      risk: "high",
      message: egress.messageJa,
      parentApprovalId: parentApprovalId || null,
      metadata: { ...invokeMetadata, sodVerdict, actionLimit, egress, dualEgress, managerId },
      body,
      egress,
      extra: {
        toolKind: toolDef.kind,
        approvalPolicy: employee.approvalPolicy,
        sodVerdict,
        actionLimit,
        egress,
        dualEgress,
        managerId,
        ...(voice ? { voice } : {}),
      },
    });
  }

  // risk_based employee + mayAuto tools: allow in stub.
  // browser.use is always force-approval; missing/mismatch already fail-closed above.
  // Reinvocation shares the same execution claim as approval callbacks and W2.
  // Use the approved snapshot, never a replacement message in this request.
  // Conversation tools: the re-run reports what fulfilling the APPROVED snapshot
  // did and never posts the request's text (2026-10-04 hole: a stub fulfillment
  // used to fall through to a fresh post of the request text).
  let approvedRerunDelivery: ConversationDelivery | undefined;
  if (priorApprovalOk && priorApproval && (isAudienceGatedTool(toolDef) || isSnsPublishTool(toolDef))) {
    // Legacy approval (snapshot predates attachment recording) + a request
    // attachment: the approved attachment is unknown → post NOTHING (no text,
    // no file) and ask for re-approval. Checked before the text is fulfilled.
    const legacyBlock = isAudienceGatedTool(toolDef)
      ? legacySnapshotAttachmentBlock(priorApproval, body)
      : null;
    if (legacyBlock) {
      await auditLegacySnapshotAttachmentBlock(priorApproval, body, {
        orgId: orgId || employee.orgId, employeeId,
        credentialId: input.credentialId || employee.credentialId, tool, purpose, jobId,
      });
      return jsonResult({ ok: false, code: legacyBlock.code, error: legacyBlock.code, message: legacyBlock.messageJa,
        approvalId: priorApproval.id, employeeId, tool, purpose, jobId }, 409);
    }
    // Duplicate post guard v2: the AI verified an earlier unknown-outcome post
    // is absent → release that row (own org + employee only) before the
    // approved snapshot is fulfilled (its gate would stop on it otherwise).
    const rerunConfirmedRef = confirmedNotDeliveredRef(body);
    if (rerunConfirmedRef) {
      await releaseConfirmedUncertainForScope(
        { orgId: orgId || employee.orgId, employeeId },
        rerunConfirmedRef,
        {
          orgId: orgId || employee.orgId, employeeId,
          credentialId: input.credentialId || employee.credentialId, purpose, tool, jobId,
          approvalId: priorApproval.id, phase: "invoke",
        }
      );
    }
    // Conversation tools: this re-run uploads the approved attachment itself
    // (deliverApprovedRerunAttachment below), so no "not_sent" marker here.
    const fulfilled = await fulfillApprovedInvoke(priorApproval, {
      attachmentHandledByCaller: isAudienceGatedTool(toolDef),
    });
    // Rate-limited (nothing posted): say how long to wait; re-running earlier stops before the provider.
    if (fulfilled && !fulfilled.ok && fulfilled.error === PROVIDER_RATE_LIMITED) {
      return jsonResult({ ...rateLimitedBody({ retryAfterSeconds: fulfilled.retryAfterSeconds ?? RETRY_AFTER_DEFAULT_SECONDS }),
        approvalId: priorApproval.id, needs_approval: false, employeeId, tool, purpose, jobId }, 429);
    }
    if (!fulfilled?.ok) return jsonResult({ ok: false, code: fulfilled?.error || "approval_execution_failed",
      error: fulfilled?.error || "approval_execution_failed", employeeId, tool, purpose, jobId }, 409);
    if (isAudienceGatedTool(toolDef)) {
      const rerun = approvedRerunConversationDelivery(fulfilled, { demo: isDemoMode() });
      if (!rerun.ok) return jsonResult({ ok: false, code: rerun.code, error: rerun.code, message: rerun.messageJa,
        employeeId, tool, purpose, jobId }, 409);
      approvedRerunDelivery = rerun.delivery;
    }
  }

  // Confirm-class succeeds only with priorApprovalOk (or non-force paths).
  let meter: {
    type: "gated_confirm_action";
    billable: boolean;
    recorded: boolean;
  } | null = null;

  // Conversation posting (Slack) after egress allow|summarize, or after human
  // approval of a needs_approval egress. Deny stays fail-closed above.
  // Notify inbox is a different plane — never post approvals through this adapter.
  let conversationDelivery: ConversationDelivery | undefined;
  let threadTsSource: "client" | "wake_stash" | "none" | undefined;
  if (isAudienceGatedTool(toolDef)) {
    const ctx = parseConversationContext(body, orgId || employee.orgId);
    const args =
      body.args && typeof body.args === "object"
        ? (body.args as Record<string, unknown>)
        : {};

    // Slack destination validation: prevent silent DM fallback from channel wakes.
    // Only validate when surface is slack or when slackChannelId/slackUserId is present.
    const isSlackSurface = ctx?.surface === "slack" || ctx?.slackChannelId || ctx?.slackUserId;
    let dest = "";
    if (isSlackSurface) {
      const dmIntent = args.dm === true || args.postingTo === "im" || args.dmIntent === true;
      const destValidation = validateSlackPostDestination({
        slackChannelId: ctx?.slackChannelId,
        slackUserId: ctx?.slackUserId,
        dmIntent,
      });
      if (!destValidation.ok) {
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.post_failed",
          purpose,
          summary: `${tool} をユーザーID宛てDM禁止で拒否（fail-closed）`,
          metadata: {
            tool,
            jobId,
            code: destValidation.code,
            slackChannelId: ctx?.slackChannelId,
            slackUserId: ctx?.slackUserId,
            dmIntent,
          },
        });
        return jsonResult(
          {
            ok: false,
            code: destValidation.code,
            error: destValidation.code,
            message: destValidation.messageJa,
            needs_approval: false,
            egress,
            employeeId,
            tool,
            purpose,
            jobId,
          },
          400
        );
      }
      dest = destValidation.dest;
    } else {
      // Non-Slack surface: use original destination resolution (email, phone, etc.)
      dest = ctx?.slackChannelId || ctx?.slackUserId || "";
    }

    // P0-RP: Enhanced reply recipient validation (fail-closed when flag ON)
    if (dest && isSlackSurface) {
      const recipientValidation = await validateReplyRecipient({
        orgId: orgId || employee.orgId,
        employee,
        context: ctx || {},
        recipientIdentifier: ctx?.slackUserId || dest,
        recipientKind: "slack_user",
      });
      if (recipientValidation.status === "denied" && recipientValidation.failClosed) {
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.post_failed",
          purpose,
          summary: `返信先が拒否されました（fail-closed）: ${recipientValidation.reason}`,
          metadata: {
            tool,
            jobId,
            recipientId: dest,
            audience: recipientValidation.audience,
            reason: recipientValidation.reason,
            failClosed: true,
            replyPolicyEnhanced: true,
          },
        });
        return jsonResult(
          {
            ok: false,
            code: "reply_recipient_denied",
            error: "reply_recipient_denied",
            message: recipientValidation.reason,
            needs_approval: false,
            egress,
            employeeId,
            tool,
            purpose,
            jobId,
          },
          403
        );
      }
    }

    const egressAllowsPost =
      egress?.decision === "allow" ||
      egress?.decision === "summarize" ||
      (priorApprovalOk && egress?.decision === "needs_approval");
    if (dest && egressAllowsPost) {
      const already = approvedRerunDelivery ?? conversationDeliveryFromFulfillment(priorApproval);
      if (already) {
        conversationDelivery = already;
      } else {
      const rawText = [args.text, args.body, args.message].find(
        (value) => typeof value === "string" && value.trim()
      ) as string | undefined;
      const explicitThreadTs = resolveConversationThreadId({
        conversation: ctx,
        args,
        body,
      });

      let replyThreadTs = explicitThreadTs;
      threadTsSource = "none";
      if (
        isSlackDmReplyInlineEnabled() &&
        isSlackDmReplyTarget({ channelId: dest, conversation: body.conversation, args })
      ) {
        // G4 (SLACK_DM_REPLY_INLINE_ENABLED): DM replies go to the DM's main flow;
        // only a message already inside a thread (thread_ts ≠ ts) keeps its thread.
        const inline = resolveSlackDmInlineThreadTs({ conversation: ctx, args, body });
        replyThreadTs = inline.threadTs;
        threadTsSource = inline.source;
      } else if (!looksLikeSlackTs(replyThreadTs) && ctx?.surface === "slack") {
        const replyPolicyResult = await getEffectiveReplyPolicy(
          orgId || employee.orgId,
          employeeId
        );
        const threadAffinity = replyPolicyResult.policy.rules?.[0]?.threadAffinity;
        if (threadAffinity === "prefer_thread") {
          const parentTs = resolveParentMessageTs({ conversation: ctx, args });
          if (looksLikeSlackTs(parentTs)) {
            replyThreadTs = parentTs;
            threadTsSource = "client";
          } else if (ctx?.slackChannelId) {
            // Fallback to wake parent stash when client did not forward ts
            const wakeParent = lookupWakeParent({
              orgId: orgId || employee.orgId,
              employeeId,
              channelId: ctx.slackChannelId,
            });
            if (wakeParent && looksLikeSlackTs(wakeParent.parentTs)) {
              replyThreadTs = wakeParent.parentTs;
              threadTsSource = "wake_stash";
              // Consume the entry to prevent stale data from accumulating
              consumeWakeParent({
                orgId: orgId || employee.orgId,
                employeeId,
                channelId: ctx.slackChannelId,
              });
            }
          }
        }
      } else if (looksLikeSlackTs(replyThreadTs)) {
        threadTsSource = "client";
      }

      // COMM_REPLY_DEDUP_ENABLED: atomic claim right before the post (two
      // concurrent identical sends → only one is posted). Fail closed.
      const dedupClaim = await claimDirectCommReplySend(commReplyDedup, tool);
      const dedupResponse = await directSendDedupResponse(dedupClaim, commReplyDedup, {
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        purpose,
        tool,
        jobId,
      });
      if (dedupResponse) return dedupResponse;
      const dedupClaimId = dedupClaim.state === "claimed" ? dedupClaim.id : null;
      let posted: Awaited<ReturnType<typeof postConversationMessage>>;
      try {
        posted = await postConversationMessage({
          orgId: orgId || employee.orgId,
          employeeId,
          postingAs: employee.postingAs || "bot",
          channel: dest,
          text: (rawText || "").trim() || purpose,
          threadTs: looksLikeSlackTs(replyThreadTs) ? replyThreadTs : undefined,
          summarize: egress?.decision === "summarize",
          slackUserId: ctx?.slackUserId,
        });
      } catch (error) {
        // Outcome unknown (the provider may have accepted it): keep the claim.
        await finishDirectCommReplySend(commReplyDedup, dedupClaimId, "uncertain", { jobId });
        throw error;
      }
      // v1: failed releases the claim. v2: only a provider-confirmed "not sent"
      // releases it; an unknown outcome is kept (uncertain) and reported.
      const ledgerOutcome = ledgerOutcomeAfterPost(commReplyDedup, posted);
      await finishDirectCommReplySend(commReplyDedup, dedupClaimId, ledgerOutcome, { jobId });
      if (!posted.ok && ledgerOutcome === "uncertain" && commReplyDedup.kind === "ready") {
        const dedupAudit: DedupAuditCtx = {
          orgId: orgId || employee.orgId, employeeId,
          credentialId: input.credentialId || employee.credentialId, purpose, tool, jobId, phase: "invoke",
        };
        if (dedupClaimId) await auditPostOutcomeUnknown(dedupAudit, commReplyDedup, dedupClaimId);
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.post_failed",
          purpose,
          summary: "Slack会話投稿の結果が不明（再送は確認後のみ）",
          metadata: { tool, jobId, error: posted.error || "slack_post_failed", dest, code: "post_outcome_unknown" },
        });
        return jsonResult(
          {
            ...postOutcomeUnknownBody(dedupClaimId, posted.error || "slack_post_failed"),
            needs_approval: false,
            egress,
            ...(voice ? { voice } : {}),
            employeeId,
            tool,
            purpose,
            jobId,
          },
          502
        );
      }
      if (!posted.ok && posted.retryAfterSeconds !== undefined) {
        // Rate-limited (not_sent, claim released above): no automatic retry —
        // the AI is told the provider's wait.
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.post_failed",
          purpose,
          summary: "Slack会話投稿がレート制限で未送信（待機後に再送可）",
          metadata: { tool, jobId, error: posted.error, dest, code: PROVIDER_RATE_LIMITED, retryAfterSeconds: posted.retryAfterSeconds },
        });
        return jsonResult(
          {
            ...rateLimitedBody({ retryAfterSeconds: posted.retryAfterSeconds, providerError: posted.error }),
            needs_approval: false,
            egress,
            ...(voice ? { voice } : {}),
            employeeId,
            tool,
            purpose,
            jobId,
          },
          429
        );
      }
      if (!posted.ok) {
        const postedError = posted.error || "slack_post_failed";
        const code =
          postedError === "slack_identity_unbound"
            ? "slack_identity_unbound"
            : postedError === "slack_not_in_channel" || postedError === "not_in_channel"
              ? "slack_not_in_channel"
              : postedError === SLACK_TOKEN_MISSING
                ? SLACK_TOKEN_MISSING
                : "slack_post_failed";
        const message =
          code === "slack_identity_unbound"
            ? "この社員の Slack 本人連携がありません"
            : code === "slack_not_in_channel"
              ? "このチャネルに参加していません（Connect では人が招待済みでも Bot は未参加のことがあります）"
              : code === SLACK_TOKEN_MISSING
                ? "この組織の Slack Bot トークンが登録されていないため投稿していません（会話投稿アダプタに組織の xoxb を登録してください）"
                : "Slack投稿に失敗しました";
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.post_failed",
          purpose,
          summary: "Slack会話投稿に失敗",
          metadata: { tool, jobId, error: postedError, dest, code },
        });
        return jsonResult(
          {
            ok: false,
            code,
            error: postedError,
            message,
            needs_approval: false,
            egress,
            ...(voice ? { voice } : {}),
            employeeId,
            tool,
            purpose,
            jobId,
          },
          502
        );
      }
      conversationDelivery = posted;

      // Add :white_check_mark: reaction on original message to indicate reply completed (flag-gated, best-effort)
      const originalTs = resolveParentMessageTs({ conversation: ctx, args });
      if (ctx?.surface === "slack" && ctx.slackChannelId && originalTs && looksLikeSlackTs(originalTs)) {
        void addCompletedReaction({
          orgId: orgId || employee.orgId,
          employeeId,
          postingAs: employee.postingAs || "bot",
          channel: ctx.slackChannelId,
          timestamp: originalTs,
        }).catch(() => undefined);
      }
      }
    } else if (!dest && egressAllowsPost && commReplyDedup.kind !== "off") {
      // Surfaces without a gateway post (LINE / Telegram / mail): the allowed
      // reply is delivered by the caller, so it is recorded here as sent.
      const dedupClaim = await claimDirectCommReplySend(commReplyDedup, tool);
      const dedupResponse = await directSendDedupResponse(dedupClaim, commReplyDedup, {
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        purpose,
        tool,
        jobId,
      });
      if (dedupResponse) return dedupResponse;
      await finishDirectCommReplySend(commReplyDedup, dedupClaim.state === "claimed" ? dedupClaim.id : null, "sent", { jobId });
    }
  }

  // File attachment handling for comm.reply / comm.send (Slack only, P0: internal thread required)
  // P0 contract: when fileAttachment was present, ALWAYS include fileUpload in response
  let fileUploadResponse: FileUploadResponse | undefined;
  // Approved re-run: only the APPROVED attachment (snapshot) is ever uploaded;
  // the request's fileAttachment is never used (lib/approvals/approved-rerun-attachment.ts).
  const approvedRerunAttachment = Boolean(priorApprovalOk && priorApproval && isAudienceGatedTool(toolDef));
  let fileAttachmentReceived = Boolean(
    isAudienceGatedTool(toolDef) &&
    body.fileAttachment?.fileRef &&
    body.fileAttachment?.filename
  );
  if (approvedRerunAttachment && priorApproval) {
    const rerunAttachment = await deliverApprovedRerunAttachment({
      approval: priorApproval,
      body,
      ctx: {
        orgId: orgId || employee.orgId, employeeId,
        credentialId: input.credentialId || employee.credentialId, tool, purpose, jobId,
      },
    });
    fileAttachmentReceived = rerunAttachment.received;
    fileUploadResponse = rerunAttachment.fileUpload;
  } else if (fileAttachmentReceived && body.fileAttachment) {
    const ctx = parseConversationContext(body, orgId || employee.orgId);
    const dest = ctx?.slackChannelId || ctx?.slackUserId || "";
    const replyThreadTs = resolveConversationThreadId({
      conversation: ctx,
      args: body.args && typeof body.args === "object"
        ? (body.args as Record<string, unknown>)
        : {},
      body,
    });

    const fileEgress = evaluateFileAttachmentEgress({
      audience: egress?.audience ?? "unknown",
      effectiveAudience: egress?.effectiveAudience ?? "external",
      threadTs: looksLikeSlackTs(replyThreadTs) ? replyThreadTs : undefined,
      channel: dest,
    });

    if (!fileEgress.allowed) {
      fileUploadResponse = buildFileUploadEgressDenied(fileEgress);
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "slack.file_egress_denied",
        purpose,
        summary: `ファイル添付を拒否: ${fileEgress.reason}`,
        metadata: {
          tool,
          jobId,
          reason: fileEgress.reason,
          audience: egress?.audience,
          effectiveAudience: egress?.effectiveAudience,
          filename: body.fileAttachment.filename,
          threadTs: replyThreadTs,
          channel: dest,
        },
      });
    } else if (dest && replyThreadTs && looksLikeSlackTs(replyThreadTs)) {
      // (6) v2: the same file + comment to the same place goes out once (same ledger;
      // own "upload:" fingerprint domain, so it never matches a text post).
      const uploadDedup = prepareFileUploadDedup(commReplyDedup, body.fileAttachment);
      const uploadClaim = await claimDirectCommReplySend(uploadDedup, tool);
      const uploadStop = dedupStopBody(uploadClaim, uploadDedup);
      if (uploadStop) {
        const uploadCtx: DedupAuditCtx = {
          orgId: orgId || employee.orgId, employeeId,
          credentialId: input.credentialId || employee.credentialId, purpose, tool, jobId, phase: "invoke",
        };
        if (uploadClaim.state === "unavailable") await auditDedupUnavailable(uploadCtx, uploadClaim.reason);
        else if (uploadClaim.state === "duplicate" && uploadDedup.kind === "ready") {
          await auditDuplicateSuppressed(uploadCtx, uploadDedup, uploadClaim as GuardDuplicate);
        }
        fileUploadResponse = {
          ok: false,
          code: String(uploadStop.body.code),
          reason: String(uploadStop.body.reasonCode),
          messageJa: `ファイルは共有していません: ${String(uploadStop.body.message)}`,
        };
      } else {
      const uploadClaimId = uploadClaim.state === "claimed" ? uploadClaim.id : null;
      let uploaded: Awaited<ReturnType<typeof uploadSlackFile>>;
      try {
      uploaded = await uploadSlackFile({
        orgId: orgId || employee.orgId,
        employeeId,
        postingAs: employee.postingAs || "bot",
        channel: dest,
        threadTs: replyThreadTs,
        fileRef: body.fileAttachment.fileRef,
        fileUrl: body.fileAttachment.fileRef.startsWith("http")
          ? body.fileAttachment.fileRef
          : undefined,
        filename: body.fileAttachment.filename,
        mimeType: body.fileAttachment.mimeType,
        title: body.fileAttachment.title,
        initialComment: body.fileAttachment.initialComment,
      });
      } catch (error) {
        await finishDirectCommReplySend(uploadDedup, uploadClaimId, "uncertain", { jobId });
        throw error;
      }
      await finishDirectCommReplySend(
        uploadDedup,
        uploadClaimId,
        uploaded.ok ? "sent" : fileUploadFailureSendState(uploaded) === "not_sent" ? "failed" : "uncertain",
        { jobId }
      );

      if (uploaded.ok) {
        fileUploadResponse = buildFileUploadSuccess(uploaded);
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.file_uploaded",
          purpose,
          summary: `Slackファイル添付: ${uploaded.filename}`,
          metadata: buildFileUploadAuditPayload(uploaded, {
            jobId,
            audience: egress?.audience ?? "unknown",
            mimeType: body.fileAttachment.mimeType,
            fileRef: body.fileAttachment.fileRef,
          }),
        });
      } else {
        fileUploadResponse = buildFileUploadFailed(uploaded);
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "slack.file_upload_failed",
          purpose,
          summary: `Slackファイル添付に失敗: ${uploaded.error}`,
          metadata: {
            tool,
            jobId,
            error: uploaded.error,
            code: uploaded.code,
            filename: body.fileAttachment.filename,
            channel: dest,
            threadTs: replyThreadTs,
            audience: egress?.audience,
          },
        });
      }
      }
    } else {
      fileUploadResponse = buildFileUploadSkipped({
        filename: body.fileAttachment.filename,
        hasDest: Boolean(dest),
        hasThreadTs: Boolean(replyThreadTs && looksLikeSlackTs(replyThreadTs)),
      });
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "slack.file_upload_failed",
        purpose,
        summary: `ファイル添付がスキップされました (dest=${Boolean(dest)}, threadTs=${Boolean(replyThreadTs)})`,
        metadata: {
          tool,
          jobId,
          code: "file_upload_skipped",
          filename: body.fileAttachment.filename,
          hasDest: Boolean(dest),
          hasThreadTs: Boolean(replyThreadTs && looksLikeSlackTs(replyThreadTs)),
          channel: dest || undefined,
          threadTs: replyThreadTs || undefined,
          audience: egress?.audience,
        },
      });
    }
  }

  let snsDelivery: SnsPublishResult | undefined;
  if (isSnsPublishTool(toolDef)) {
    const already = snsDeliveryFromFulfillment(priorApproval);
    if (already?.ok) {
      snsDelivery = already;
    } else if (priorApprovalOk && already && !already.ok) {
      snsDelivery = already;
    } else {
      const args =
        body.args && typeof body.args === "object"
          ? (body.args as Record<string, unknown>)
          : {};
      const rawText = [args.text, args.body, args.message].find(
        (value) => typeof value === "string" && value.trim()
      );
      // (6) v2: the same ledger as conversation posts (claim right before the post).
      const snsCtx = {
        orgId: orgId || employee.orgId, employeeId,
        credentialId: input.credentialId || employee.credentialId, purpose, tool, jobId,
      };
      const snsClaim = await claimDirectCommReplySend(commReplyDedup, tool);
      const snsStop = await directSendDedupResponse(snsClaim, commReplyDedup, snsCtx);
      if (snsStop) return snsStop;
      const snsClaimId = snsClaim.state === "claimed" ? snsClaim.id : null;
      let posted: SnsPublishResult;
      try {
        posted = await publishSnsPost({
          orgId: orgId || employee.orgId,
          employeeId,
          surface: args.surface ?? args.snsSurface ?? args.media,
          text: typeof rawText === "string" ? rawText : purpose,
          scheduledAt: args.scheduledAt ?? args.scheduled_at ?? args.scheduledFor,
          title: args.title,
        });
      } catch (error) {
        await finishDirectCommReplySend(commReplyDedup, snsClaimId, "uncertain", { jobId });
        throw error;
      }
      const snsLedgerOutcome = ledgerOutcomeAfterPost(commReplyDedup, posted);
      await finishDirectCommReplySend(commReplyDedup, snsClaimId, snsLedgerOutcome, { jobId });
      snsDelivery = posted;
      if (!posted.ok && snsLedgerOutcome === "uncertain" && commReplyDedup.kind === "ready") {
        if (snsClaimId) await auditPostOutcomeUnknown({ ...snsCtx, phase: "invoke" }, commReplyDedup, snsClaimId);
        return jsonResult(
          { ...postOutcomeUnknownBody(snsClaimId, posted.error), needs_approval: false, employeeId, tool, purpose, jobId },
          502
        );
      }
      if (!posted.ok) {
        const snsWait = posted.retryAfterSeconds;
        await appendAuditEvent({
          orgId: orgId || employee.orgId,
          employeeId,
          credentialId: input.credentialId || employee.credentialId,
          action: "sns.publish_failed",
          purpose,
          summary: snsWait !== undefined ? "SNS投稿がレート制限で未送信（待機後に再送可）" : "SNS投稿に失敗",
          metadata: {
            tool,
            jobId,
            error: posted.error,
            surface: posted.surface,
            phase: priorApprovalOk ? "reinvoke" : "auto",
            ...(snsWait !== undefined ? { code: PROVIDER_RATE_LIMITED, retryAfterSeconds: snsWait } : {}),
          },
        });
        if (snsWait !== undefined) {
          return jsonResult(
            { ...rateLimitedBody({ retryAfterSeconds: snsWait, providerError: posted.error }), needs_approval: false, employeeId, tool, purpose, jobId },
            429
          );
        }
        return jsonResult(
          {
            ok: false,
            code: "sns_publish_failed",
            error: posted.error,
            message: posted.error,
            needs_approval: false,
            employeeId,
            tool,
            purpose,
            jobId,
          },
          502
        );
      }
    }
  }

  if (employee.actionLimits?.[tool]) {
    await incrementActionCounter({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      tool,
      jobId,
      purpose,
    });
  }

  if (isBillableConfirmCompletion(toolDef) && isConfirmClassTool(toolDef)) {
    // Successful confirm-class completion → billable meter (P0).
    await recordGatedConfirmAction({
      orgId: orgId || employee.orgId,
      employeeId,
      tool,
      jobId,
      purpose,
      credentialId: input.credentialId || employee.credentialId,
      billable: true,
    });
    meter = {
      type: "gated_confirm_action",
      billable: true,
      recorded: true,
    };
  }

  if (!priorApprovalOk) {
    const destCtx = parseConversationContext(body, orgId || employee.orgId);
    const deliveryChannel =
      conversationDelivery && "channel" in conversationDelivery
        ? conversationDelivery.channel
        : undefined;
    const destination =
      destCtx?.slackChannelId ||
      destCtx?.email ||
      destCtx?.slackUserId ||
      destCtx?.phone ||
      destCtx?.lineId ||
      (typeof body.args?.to === "string" ? body.args.to : null) ||
      deliveryChannel ||
      null;
    await appendAuditEvent({
      orgId: orgId || employee.orgId,
      employeeId,
      credentialId: input.credentialId || employee.credentialId,
      action: "tool.invoke",
      purpose,
      summary: `${tool} を自動実行`,
      metadata: {
        tool,
        purpose,
        destination,
        employeeId,
        acknowledged: true,
        auto: true,
        approvalPolicy: employee.approvalPolicy,
        egress,
        dualEgress,
        // Ids + the token that posted (no body): lets comm.delete prove the
        // post is this employee's own and delete it with the same token.
        ...(() => {
          const postRecord = buildSlackPostRecord(conversationDelivery);
          return postRecord ? { postRecord } : {};
        })(),
      },
    });
  }

  // calendar.read: query Google freebusy (only when flag ON; flag OFF falls through to generic path)
  if (isGoogleCalendarReadEnabled() && tool === "calendar.read") {
    const args = (body.args || {}) as Record<string, unknown>;
    const calendarIds = Array.isArray(args.calendarIds)
      ? (args.calendarIds as string[])
      : typeof args.calendarIds === "string"
        ? [args.calendarIds]
        : [];
    const timeMin = typeof args.timeMin === "string" ? args.timeMin : "";
    const timeMax = typeof args.timeMax === "string" ? args.timeMax : "";

    const readResult = await readCalendarFreebusy({
      orgId: orgId || employee.orgId,
      employeeId,
      jobId,
      calendarIds,
      timeMin,
      timeMax,
    });

    return jsonResult({
      ok: readResult.ok,
      tool,
      employeeId,
      purpose,
      jobId,
      busyByCalendar: readResult.busyByCalendar,
      errors: readResult.errors,
      refused: readResult.refused,
      queried: readResult.queried,
      ...(readResult.nextStepJa ? { nextStepJa: readResult.nextStepJa } : {}),
      ...(readResult.readErrorHints ? { readErrorHints: readResult.readErrorHints } : {}),
      ...(readResult.busyDataComplete !== undefined ? { busyDataComplete: readResult.busyDataComplete } : {}),
    });
  }

  // calendar.propose: fetches busy and applies policy (only when flag ON; flag OFF falls through to generic path)
  if (isGoogleCalendarReadEnabled() && tool === "calendar.propose") {
    const args = (body.args || {}) as Record<string, unknown>;
    const slots = Array.isArray(args.slots) ? args.slots : [];
    const calendarIds = Array.isArray(args.calendarIds)
      ? (args.calendarIds as string[])
      : [];
    const timeMin = typeof args.timeMin === "string" ? args.timeMin : "";
    const timeMax = typeof args.timeMax === "string" ? args.timeMax : "";
    const requestedVideoTool = typeof args.videoTool === "string" ? args.videoTool : undefined;
    let busyByCalendar = (args.busyByCalendar || {}) as Record<string, Array<{ start: string; end: string }>>;
    let readErrors: Record<string, { code: string; message: string }> = {};
    let readErrorHints: Record<string, string> = {};
    let busyDataComplete = true;
    let nextStepJa: string | undefined;

    if (calendarIds.length > 0 && timeMin && timeMax) {
      const readResult = await readCalendarFreebusy({
        orgId: orgId || employee.orgId,
        employeeId,
        jobId,
        calendarIds,
        timeMin,
        timeMax,
      });
      if (readResult.ok) {
        busyByCalendar = { ...busyByCalendar, ...readResult.busyByCalendar };
        if (Object.keys(readResult.errors).length > 0) {
          readErrors = readResult.errors;
          busyDataComplete = false;
          if (readResult.readErrorHints) {
            readErrorHints = readResult.readErrorHints;
          }
          if (readResult.nextStepJa) {
            nextStepJa = readResult.nextStepJa;
          }
        }
      } else {
        readErrors = readResult.errors;
        busyDataComplete = false;
        if (readResult.readErrorHints) {
          readErrorHints = readResult.readErrorHints;
        }
        if (readResult.nextStepJa) {
          nextStepJa = readResult.nextStepJa;
        }
      }
    }

    const proposeInput: ProposeInput = {
      slots: slots.map((s: unknown) => {
        const slot = s as { start?: string; end?: string; id?: string };
        return { start: slot.start || "", end: slot.end || "", id: slot.id || "" };
      }),
      context: {
        orgId: orgId || employee.orgId,
        employeeId,
        jobId,
      },
      requestedVideoTool,
      busyByCalendar,
    };

    const proposeResult = await applySchedulingPolicyToPropose(proposeInput);

    return jsonResult({
      ok: true,
      tool,
      employeeId,
      purpose,
      jobId,
      proposed: true,
      slots: proposeResult.finalCandidates,
      policyApplied: proposeResult.policyApplied,
      policyId: proposeResult.policyId,
      policyName: proposeResult.policyName,
      droppedCount: proposeResult.droppedCount,
      keptCount: proposeResult.keptCount,
      onlineSettings: proposeResult.onlineSettings,
      busyByCalendarUsed: Object.keys(busyByCalendar).length > 0,
      busyDataComplete,
      ...(Object.keys(readErrors).length > 0 ? { readErrors } : {}),
      ...(Object.keys(readErrorHints).length > 0 ? { readErrorHints } : {}),
      ...(nextStepJa ? { nextStepJa } : {}),
    });
  }

  // calendar.allowlist.patch: fulfillment after approval (flag-gated)
  if (tool === "calendar.allowlist.patch") {
    if (!isGoogleCalendarReadEnabled()) {
      return jsonResult({
        ok: false,
        code: "feature_disabled",
        error: "feature_disabled",
        message: "Google Calendar integration is disabled (flag OFF)",
        employeeId,
        tool,
        purpose,
        jobId,
      }, 400);
    }

    if (!priorApprovalOk) {
      return jsonResult({
        ok: false,
        code: "approval_required",
        error: "approval_required",
        message: "calendar.allowlist.patch requires prior human approval",
        needs_approval: true,
        employeeId,
        tool,
        purpose,
        jobId,
      }, 402);
    }

    // Single-use: check if approval already has fulfillment (replay)
    if (priorApproval) {
      const existingFulfillment = parseFulfillment(priorApproval.metadata);
      if (existingFulfillment) {
        return jsonResult({
          ok: existingFulfillment.ok,
          tool,
          employeeId,
          purpose,
          jobId,
          replay: true,
          fulfillment: existingFulfillment,
        });
      }

      // Atomically claim the approval before executing (only first caller wins)
      const admin = createSupabaseAdminClient();
      if (!admin) {
        return jsonResult({
          ok: false,
          code: "claim_failed",
          error: "claim_failed",
          message: "Database unavailable for claim",
          employeeId,
          tool,
          purpose,
          jobId,
        }, 503);
      }
      const { data: claimResult, error: claimError } = await admin.rpc("claim_approval_fulfillment", {
        p_id: priorApproval.id,
        p_org: priorApproval.orgId,
        p_tool: tool,
      });
      if (claimError || claimResult !== true) {
        // Claim failed - either already fulfilled or concurrent claim won
        // Re-fetch to get the fulfillment result
        const refreshed = await getApprovalById(priorApproval.id, priorApproval.orgId);
        const refreshedFulfillment = refreshed ? parseFulfillment(refreshed.metadata) : null;
        if (refreshedFulfillment) {
          return jsonResult({
            ok: refreshedFulfillment.ok,
            tool,
            employeeId,
            purpose,
            jobId,
            replay: true,
            fulfillment: refreshedFulfillment,
          });
        }
        return jsonResult({
          ok: false,
          code: "claim_failed",
          error: "claim_failed",
          message: "Approval claim failed - concurrent execution or already fulfilled",
          employeeId,
          tool,
          purpose,
          jobId,
        }, 409);
      }
    }

    const args = (body.args || {}) as Record<string, unknown>;
    const action = typeof args.action === "string" ? args.action : "add";
    const calendarId = typeof args.calendarId === "string" ? args.calendarId : "";
    const grantId = typeof args.grantId === "string" ? args.grantId : "";
    const label = typeof args.label === "string" ? args.label : "";
    const targetEmployeeId = typeof args.employeeId === "string" ? args.employeeId : null;

    // Validate calendarId format: non-empty, max 254 chars, no whitespace or control chars
    if (action === "add") {
      if (!calendarId || calendarId.length > 254) {
        return jsonResult({
          ok: false,
          code: "invalid_calendar_id",
          error: "invalid_calendar_id",
          message: "calendarId must be non-empty and at most 254 characters",
          employeeId,
          tool,
          purpose,
          jobId,
        }, 400);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\s\x00-\x1f\x7f]/.test(calendarId)) {
        return jsonResult({
          ok: false,
          code: "invalid_calendar_id",
          error: "invalid_calendar_id",
          message: "calendarId must not contain whitespace or control characters",
          employeeId,
          tool,
          purpose,
          jobId,
        }, 400);
      }
    }

    // Validate targetEmployeeId: must belong to same org if provided
    if (targetEmployeeId) {
      const targetEmployee = await getEmployee(targetEmployeeId, orgId || employee.orgId);
      if (!targetEmployee) {
        return jsonResult({
          ok: false,
          code: "invalid_target_employee",
          error: "invalid_target_employee",
          message: "targetEmployeeId must belong to the same organization",
          employeeId,
          tool,
          purpose,
          jobId,
        }, 400);
      }
    }

    if (action === "add" && calendarId) {
      const grant = await addCalendarReadGrant({
        orgId: orgId || employee.orgId,
        employeeId: targetEmployeeId,
        calendarId,
        label,
        approvalId: priorApprovalId,
      });
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "calendar.allowlist_patch",
        purpose,
        summary: `Calendar allowlist grant added: ${calendarId}`,
        metadata: { grantId: grant.id, calendarId, targetEmployeeId, approvalId: priorApprovalId, jobId },
      });
      // Record fulfillment
      if (priorApproval) {
        await updateApprovalMetadata(priorApproval, {
          fulfillment: { ok: true, at: new Date().toISOString(), delivery: "stub", action: "add", grantId: grant.id },
        });
      }
      return jsonResult({
        ok: true,
        tool,
        employeeId,
        purpose,
        jobId,
        action: "add",
        grant,
      });
    } else if (action === "revoke" && grantId) {
      await revokeCalendarReadGrant({
        grantId,
        orgId: orgId || employee.orgId,
      });
      await appendAuditEvent({
        orgId: orgId || employee.orgId,
        employeeId,
        credentialId: input.credentialId || employee.credentialId,
        action: "calendar.allowlist_patch",
        purpose,
        summary: `Calendar allowlist grant revoked: ${grantId}`,
        metadata: { grantId, approvalId: priorApprovalId, jobId },
      });
      // Record fulfillment
      if (priorApproval) {
        await updateApprovalMetadata(priorApproval, {
          fulfillment: { ok: true, at: new Date().toISOString(), delivery: "stub", action: "revoke", grantId },
        });
      }
      return jsonResult({
        ok: true,
        tool,
        employeeId,
        purpose,
        jobId,
        action: "revoke",
        grantId,
      });
    }

    return jsonResult({
      ok: false,
      code: "invalid_action",
      error: "invalid_action",
      message: "action must be 'add' or 'revoke' with appropriate arguments",
      employeeId,
      tool,
      purpose,
      jobId,
    }, 400);
  }

  return jsonResult({
    ok: true,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    employeeId,
    agentId: decision.binding.grokBotAgentId,
    generation: decision.binding.credentialGeneration,
    tool,
    purpose,
    jobId,
    toolKind: toolDef.kind,
    priorApprovalId: priorApprovalId || undefined,
    meter,
    egress: egress ?? undefined,
    dualEgress: dualEgress ?? undefined,
    managerId: managerId || undefined,
    ...(voice ? { voice } : {}),
    ...(tool === "knowledge.search"
      ? { projectAccess: projectScope.projectAccess }
      : {}),
    conversationDelivery,
    snsDelivery,
    ...(duplicateWarning ? { duplicateWarning } : {}),
    result:
      tool === "tools.ping"
        ? { pong: true }
        : tool === "mail.draft"
            ? { drafted: true }
            : tool === "commerce.quote"
              ? { quoted: true }
              : tool === "calendar.confirm"
                ? { confirmed: true }
                : tool === "mail.send"
                  ? { sent: true }
                  : tool === "commerce.order"
                    ? { ordered: true }
                    : tool === "knowledge.search"
                      ? {
                          accepted: true,
                          hits: [],
                          projectAccess: projectScope.projectAccess,
                          projects: accessibleProjects(
                            employee,
                            projectScope.projects,
                            projectScope.defaultProjectId
                          ).map((item) => ({
                            id: item.id,
                            slug: item.slug,
                            name: item.name,
                            isDefault: item.isDefault,
                          })),
                        }
                      : tool === "sns.publish"
                        ? {
                            published: Boolean(snsDelivery?.ok),
                            delivery: snsDelivery && snsDelivery.ok ? snsDelivery.delivery : undefined,
                            snsDelivery,
                          }
                      : tool === "comm.send" || tool === "comm.reply"
                      ? {
                          accepted: true,
                          disclosed: egress?.decision === "summarize" ? "summary" : "source",
                          delivery: conversationDelivery?.delivery,
                          conversationDelivery,
                          threadTsSource: threadTsSource || undefined,
                          fileAttachmentReceived: fileAttachmentReceived || undefined,
                          fileUpload: fileUploadResponse,
                        }
                      : {
                          accepted: true,
                          disclosed: egress?.decision === "summarize" ? "summary" : undefined,
                          delivery: conversationDelivery?.delivery,
                          conversationDelivery,
                          threadTsSource: threadTsSource || undefined,
                          fileAttachmentReceived: fileAttachmentReceived || undefined,
                          fileUpload: fileUploadResponse,
                        },
    message:
      egress?.decision === "summarize"
        ? egress.messageJa
        : isConfirmClassTool(toolDef)
          ? `invoke completed (${tool}; gated_confirm_action metered)`
          : `invoke allowed (${tool}; propose/draft/read not billed)`,
  });
}
