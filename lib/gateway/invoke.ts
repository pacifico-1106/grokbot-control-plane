import {
  buildApprovalArtifact,
  buildApprovalTitle,
  buildArtifactLines,
  buildRichApprovalSummary,
  inferRiskForTool,
} from "@/lib/approvals/summary";
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
} from "@/lib/data";
import {
  isBillableConfirmCompletion,
  recordGatedConfirmAction,
} from "@/lib/billing/meter";
import { evaluateEgressMatrix } from "@/lib/gateway/egress";
import {
  parseConversationContext,
  resolveAudience,
  resolveConversationThreadId,
} from "@/lib/gateway/audience";
import { resolveInformationDisclosure } from "@/lib/gateway/information-class";
import { evaluateProjectScope } from "@/lib/gateway/project-scope";
import { accessibleProjects } from "@/lib/employees/project-access";
import {
  employeeHasToolScope,
  isAudienceGatedTool,
  isConfirmClassTool,
  toolRequiresHumanApproval,
  resolveGatewayTool,
} from "@/lib/gateway/tools";
import {
  looksLikeSlackTs,
  postConversationMessage,
} from "@/lib/gateway/adapters/slack";
import {
  buildInvokeSnapshot,
  conversationDeliveryFromFulfillment,
  type ConversationDelivery,
} from "@/lib/approvals/fulfill";
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
import type { Employee, EgressVerdict, GatewayInvokeRequest } from "@/lib/types";
import {
  CrossProductEventError,
  normalizeCommerceAuthorization,
} from "@/lib/commerce/cross-product-events";

export type GatewayInvokeResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

function jsonResult(
  body: Record<string, unknown>,
  httpStatus = 200
): GatewayInvokeResult {
  return { httpStatus, body };
}

async function evaluateInvokeEgress(input: {
  orgId: string;
  tool: string;
  toolDef: import("@/lib/gateway/tools").GatewayToolDef;
  body: import("@/lib/types").GatewayInvokeRequest;
}): Promise<import("@/lib/types").EgressVerdict | null> {
  const gated = isAudienceGatedTool(input.toolDef);
  const ctx = parseConversationContext(input.body, input.orgId);
  if (!gated && !ctx) return null;
  const audience = await resolveAudience(ctx, { requireDestination: gated });
  const disclosure = await resolveInformationDisclosure({
    orgId: input.orgId,
    tool: input.tool,
    body: input.body,
    audience: audience.audience,
  });
  return evaluateEgressMatrix({
    audience: audience.audience,
    informationClass: disclosure.informationClass,
    fidelity: disclosure.fidelity,
    namedRecipients: audience.namedRecipients,
  });
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
  const extraLines = buildArtifactLines(
    opts.tool,
    opts.body,
    opts.egress ?? null,
    conversation
  );
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
        invoke: buildInvokeSnapshot({
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
        }),
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

export type RunGatewayInvokeInput = {
  employeeId: string;
  body: GatewayInvokeRequest;
  /** Optional credential id from Bearer resolution */
  credentialId?: string | null;
};

/**
 * Core Gateway enforcement. Callers must already resolve employeeId
 * (via Bearer badge and/or x-employee-id).
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

  // Bot invokes often send x-employee-id only (no browser session).
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
  const egress = await evaluateInvokeEgress({
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
      metadata: { tool, jobId, egress, managerId },
    });
    return jsonResult(
      {
        ok: false,
        code: "egress_denied",
        error: egress.reason,
        message: egress.messageJa,
        needs_approval: false,
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
        metadata: { tool, jobId, phrase, voice, egress, managerId },
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
  const amountJpy =
    tool === "commerce.order"
      ? body.amountJpy == null
        ? Number.NaN
        : Number(body.amountJpy)
      : Number.NaN;
  let spend =
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

  const forceApproval =
    perToolHuman ||
    employee.approvalPolicy === "always_human" ||
    actionLimit.decision === "needs_approval" ||
    spend?.decision === "needs_approval";

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
        metadata: { ...invokeMetadata, sodVerdict, actionLimit, egress, managerId },
        body,
        egress,
        extra: { spend, actionLimit, sodVerdict, egress, managerId, ...(voice ? { voice } : {}), toolKind: toolDef.kind, approvalPolicy: employee.approvalPolicy },
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
      risk: inferRiskForTool(tool),
      message:
        actionLimit.decision === "needs_approval"
            ? actionLimit.message
            : tool === "browser.use"
          ? `${tool} requires human approval (always_human). allowedAccounts checked; live browser identity remains partial.`
          : `${tool} requires human approval (always_human default for confirm/send/order)`,
      parentApprovalId: parentApprovalId || null,
      metadata: { ...invokeMetadata, sodVerdict, actionLimit, egress, managerId },
      body,
      egress,
      extra: {
        toolKind: toolDef.kind,
        approvalPolicy: employee.approvalPolicy,
        sodVerdict,
        actionLimit,
        egress,
        managerId,
        ...(voice ? { voice } : {}),
        ...(browserIdentityMeta
          ? {
              browserIdentityCheck: browserIdentityMeta.browserIdentityCheck,
              browserIdentityNoteJa: browserIdentityMeta.noteJa,
              matchedAccount: browserIdentityMeta.matchedAccount,
              allowedAccounts: employee.allowedAccounts ?? [],
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
      metadata: { ...invokeMetadata, sodVerdict, actionLimit, egress, managerId },
      body,
      egress,
      extra: {
        toolKind: toolDef.kind,
        approvalPolicy: employee.approvalPolicy,
        sodVerdict,
        actionLimit,
        egress,
        managerId,
        ...(voice ? { voice } : {}),
      },
    });
  }

  // risk_based employee + mayAuto tools: allow in stub.
  // browser.use is always force-approval; missing/mismatch already fail-closed above.
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
  if (isAudienceGatedTool(toolDef)) {
    const ctx = parseConversationContext(body, orgId || employee.orgId);
    const dest = ctx?.slackChannelId || ctx?.slackUserId || "";
    const egressAllowsPost =
      egress?.decision === "allow" ||
      egress?.decision === "summarize" ||
      (priorApprovalOk && egress?.decision === "needs_approval");
    if (dest && egressAllowsPost) {
      const already = conversationDeliveryFromFulfillment(priorApproval);
      if (already) {
        conversationDelivery = already;
      } else {
      const args =
        body.args && typeof body.args === "object"
          ? (body.args as Record<string, unknown>)
          : {};
      const rawText = [args.text, args.body, args.message].find(
        (value) => typeof value === "string" && value.trim()
      ) as string | undefined;
      const replyThreadTs = resolveConversationThreadId({
        conversation: ctx,
        args,
        body,
      });
      const posted = await postConversationMessage({
        orgId: orgId || employee.orgId,
        employeeId,
        postingAs: employee.postingAs || "bot",
        channel: dest,
        text: (rawText || "").trim() || purpose,
        threadTs: looksLikeSlackTs(replyThreadTs) ? replyThreadTs : undefined,
        // After human approval of needs_approval, post FULL text (not 【要約のみ】).
        summarize: egress?.decision === "summarize",
      });
      if (!posted.ok) {
        const postedError = posted.error || "slack_post_failed";
        const code =
          postedError === "slack_identity_unbound"
            ? "slack_identity_unbound"
            : postedError === "slack_not_in_channel" || postedError === "not_in_channel"
              ? "slack_not_in_channel"
              : "slack_post_failed";
        const message =
          code === "slack_identity_unbound"
            ? "この社員の Slack 本人連携がありません"
            : code === "slack_not_in_channel"
              ? "このチャネルに参加していません（Connect では人が招待済みでも Bot は未参加のことがあります）"
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
      },
    });
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
    managerId: managerId || undefined,
    ...(voice ? { voice } : {}),
    ...(tool === "knowledge.search"
      ? { projectAccess: projectScope.projectAccess }
      : {}),
    conversationDelivery,
    result:
      tool === "tools.ping"
        ? { pong: true }
        : tool === "calendar.propose"
          ? { proposed: true, slots: [] }
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
                      : tool === "comm.send" || tool === "comm.reply"
                      ? {
                          accepted: true,
                          disclosed: egress?.decision === "summarize" ? "summary" : "source",
                          delivery: conversationDelivery?.delivery,
                          conversationDelivery,
                        }
                      : {
                          accepted: true,
                          disclosed: egress?.decision === "summarize" ? "summary" : undefined,
                          delivery: conversationDelivery?.delivery,
                          conversationDelivery,
                        },
    message:
      egress?.decision === "summarize"
        ? egress.messageJa
        : isConfirmClassTool(toolDef)
          ? `invoke completed (${tool}; gated_confirm_action metered)`
          : `invoke allowed (${tool}; propose/draft/read not billed)`,
  });
}
