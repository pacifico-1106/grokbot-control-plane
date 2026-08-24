import { NextResponse } from "next/server";
import {
  buildApprovalTitle,
  buildRichApprovalSummary,
  inferRiskForTool,
} from "@/lib/approvals/summary";
import { sendApprovalNeededEmail } from "@/lib/email";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  assertExecutable,
  createApproval,
  getApprovalById,
  getBinding,
  getEmployee,
  runtimeModeLabel,
} from "@/lib/data";
import {
  isBillableConfirmCompletion,
  recordGatedConfirmAction,
} from "@/lib/billing/meter";
import {
  employeeHasToolScope,
  isConfirmClassTool,
  isForceApprovalTool,
  resolveGatewayTool,
} from "@/lib/gateway/tools";
import { evaluateAllowedAccountsForBrowser } from "@/lib/employees/allowed-accounts";
import { evaluateSpend } from "@/lib/spend-gate";
import type { GatewayInvokeRequest } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Fail-closed tool invoke (P0 contract).
 * - purpose + jobId (or job_id) required
 * - unregistered tools rejected
 * - confirm / send / order force needs_approval
 * - browser.use: allowedAccounts missing/mismatch → fail-closed (C5)
 * - AgentMail tools are reserved (P0.5) — no live send
 */

async function createNeedsApprovalResponse(opts: {
  employeeId: string;
  orgId: string;
  credentialId: string | null;
  employeeDisplayName: string;
  tool: string;
  purpose: string;
  jobId: string;
  risk?: "low" | "medium" | "high";
  amountJpy?: number | null;
  message: string;
  extra?: Record<string, unknown>;
  httpStatus?: number;
}) {
  const risk = opts.risk || inferRiskForTool(opts.tool);
  const title = buildApprovalTitle(opts.tool, opts.purpose);
  const summary = buildRichApprovalSummary({
    tool: opts.tool,
    purpose: opts.purpose,
    jobId: opts.jobId,
    employeeDisplayName: opts.employeeDisplayName,
    amountJpy: opts.amountJpy,
    risk,
  });

  let approvalId: string | null = null;
  let statusToken: string | null = null;
  let pollUrl: string | null = null;
  let pollPath: string | null = null;
  let demoStore: string | null = null;

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
    });
    approvalId = created.approval.id;
    statusToken = created.statusToken;
    pollUrl = created.pollUrl;
    pollPath = created.approval.pollPath;
    demoStore = created.demoStore ?? null;
  } catch (e) {
    // Still return needs_approval so Bot stops; ticket create failure is surfaced.
    const errMsg = e instanceof Error ? e.message : "approval_create_failed";
    return NextResponse.json(
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
        ...opts.extra,
      },
      { status: opts.httpStatus ?? 402 }
    );
  }

  // Best-effort human notify (Resend stub in DEMO).
  const notifyTo =
    process.env.BILLING_NOTIFY_EMAIL ||
    process.env.APPROVAL_NOTIFY_EMAIL ||
    "owner@example.com";
  void sendApprovalNeededEmail(notifyTo, summary, risk).catch(() => null);

  return NextResponse.json(
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
      title,
      summary,
      risk,
      employeeId: opts.employeeId,
      tool: opts.tool,
      purpose: opts.purpose,
      jobId: opts.jobId,
      demoStore,
      ...opts.extra,
    },
    { status: opts.httpStatus ?? 402 }
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as GatewayInvokeRequest;
  const headerId = req.headers.get("x-employee-id") || undefined;
  const employeeId = (body.employeeId || headerId || "").trim();

  if (!employeeId) {
    return NextResponse.json(
      {
        ok: false,
        code: "unbound",
        error: "employee_id_required",
        message: "employeeId required; refuse invoke (fail-closed)",
      },
      { status: 401 }
    );
  }

  const purpose = (body.purpose || "").trim();
  const jobId = (body.jobId || body.job_id || "").trim();
  const toolRaw = (body.tool || "").trim();

  if (!purpose) {
    return NextResponse.json(
      {
        ok: false,
        code: "purpose_required",
        error: "purpose_required",
        message: "purpose is required on gateway invoke (fail-closed)",
      },
      { status: 400 }
    );
  }

  if (!jobId) {
    return NextResponse.json(
      {
        ok: false,
        code: "job_id_required",
        error: "job_id_required",
        message: "jobId (or job_id) is required on gateway invoke (fail-closed)",
      },
      { status: 400 }
    );
  }

  if (!toolRaw) {
    return NextResponse.json(
      {
        ok: false,
        code: "tool_required",
        error: "tool_required",
        message: "tool is required; unregistered tools are rejected",
      },
      { status: 400 }
    );
  }

  const resolved = resolveGatewayTool(toolRaw);
  if (!resolved.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "unknown_tool",
        error: "unknown_tool",
        tool: resolved.tool || toolRaw,
        message:
          "unregistered tool rejected (fail-closed). Use allowlisted tools only (e.g. calendar.propose / calendar.confirm, mail.draft / mail.send).",
      },
      { status: 403 }
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
    return NextResponse.json(
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
      { status }
    );
  }

  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(employeeId, orgId);

  if (!employee) {
    return NextResponse.json(
      {
        ok: false,
        code: "not_found",
        error: "employee_not_found",
        message: "employee not found",
        purpose,
        jobId,
        tool,
      },
      { status: 401 }
    );
  }

  if (
    employee.allowedPurposes?.length &&
    !employee.allowedPurposes.includes(purpose)
  ) {
    return NextResponse.json(
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
      { status: 403 }
    );
  }

  if (!employeeHasToolScope(employee.scopes, toolDef)) {
    return NextResponse.json(
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
      { status: 403 }
    );
  }

  // AgentMail: P0.5 reservation only — never live-send in P0.
  if (toolDef.reserved) {
    return NextResponse.json(
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
      { status: 501 }
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
      return NextResponse.json(
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
        { status: 403 }
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
  if (priorApprovalId) {
    const prior = await getApprovalById(priorApprovalId, orgId || employee.orgId);
    priorApprovalOk = Boolean(
      prior &&
        prior.status === "approved" &&
        prior.employeeId === employeeId
    );
  }

  // confirm / send / order (and force flags) → always needs_approval
  // unless a matching prior approval unlocks execution.
  const forceApproval =
    isForceApprovalTool(toolDef) ||
    employee.approvalPolicy === "always_human";

  if (
    forceApproval &&
    tool !== "tools.ping" &&
    tool !== "audit.append" &&
    !priorApprovalOk
  ) {
    // commerce.order still runs spend gate for richer reason codes.
    if (tool === "commerce.order") {
      const amountJpy =
        body.amountJpy == null ? Number.NaN : Number(body.amountJpy);
      const spend = evaluateSpend({
        amountJpy,
        limits: employee.spend,
        approvalPolicy: "always_human",
        isFirstOrder: body.isFirstOrder,
        spentTodayJpy: body.spentTodayJpy,
        spentThisMonthJpy: body.spentThisMonthJpy,
      });
      if (spend.decision === "deny") {
        return NextResponse.json(
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
          { status: 403 }
        );
      }
      return createNeedsApprovalResponse({
        employeeId,
        orgId: orgId || employee.orgId,
        credentialId: employee.credentialId,
        employeeDisplayName: employee.displayName,
        tool,
        purpose,
        jobId,
        risk: "high",
        amountJpy: Number.isFinite(amountJpy) ? amountJpy : null,
        message: spend.message,
        extra: { spend, toolKind: toolDef.kind, approvalPolicy: employee.approvalPolicy },
      });
    }

    return createNeedsApprovalResponse({
      employeeId,
      orgId: orgId || employee.orgId,
      credentialId: employee.credentialId,
      employeeDisplayName: employee.displayName,
      tool,
      purpose,
      jobId,
      risk: inferRiskForTool(tool),
      message:
        tool === "browser.use"
          ? `${tool} requires human approval (always_human). allowedAccounts checked; live browser identity remains partial.`
          : `${tool} requires human approval (always_human default for confirm/send/order)`,
      extra: {
        toolKind: toolDef.kind,
        approvalPolicy: employee.approvalPolicy,
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

  // risk_based employee + mayAuto tools: allow in stub.
  // browser.use is always force-approval; missing/mismatch already fail-closed above.
  // Confirm-class succeeds only with priorApprovalOk (or non-force paths).
  let meter: {
    type: "gated_confirm_action";
    billable: boolean;
    recorded: boolean;
  } | null = null;

  if (isBillableConfirmCompletion(toolDef) && isConfirmClassTool(toolDef)) {
    // Successful confirm-class completion → billable meter (P0).
    await recordGatedConfirmAction({
      orgId: orgId || employee.orgId,
      employeeId,
      tool,
      jobId,
      purpose,
      credentialId: employee.credentialId,
      billable: true,
    });
    meter = {
      type: "gated_confirm_action",
      billable: true,
      recorded: true,
    };
  }

  return NextResponse.json({
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
                    : { accepted: true },
    message: isConfirmClassTool(toolDef)
      ? `invoke completed (${tool}; gated_confirm_action metered)`
      : `invoke allowed (${tool}; propose/draft/read not billed)`,
  });
}
