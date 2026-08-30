import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { assertBillingAllows } from "@/lib/billing/entitlements";
import { appendAuditEvent, issueEmployee, listNotificationChannels, runtimeModeLabel } from "@/lib/data";
import { normalizeActionLimits } from "@/lib/action-gate";
import { evaluateSod } from "@/lib/employees/sod";
import { sodAckRequired } from "@/lib/employees/sod-override";
import { getOrgSodWarnPolicy } from "@/lib/data";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { POLICY_ERROR_MESSAGES, policyErrorPayload } from "@/lib/employees/policy-errors";
import {
  buildDefaultApprovalRoutine,
  buildHireInstructionsSnippet,
} from "@/lib/employees/approval-loop-copy";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { normalizeApproverUserIds, parseApprovalChannelId } from "@/lib/employees/approval-inbox";
import { requireCapability } from "@/lib/team/demo-actor";
import type { ActionLimits, AllowedAccount, ApprovalPolicy, EmployeeScope, SpendLimits } from "@/lib/types";

export const runtime = "nodejs";

function issueSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

/**
 * Confirm Draft → create employee + issue credential.
 * Dual-mode: DEMO in-memory / production Supabase via lib/data.
 */
export async function POST(req: Request) {
  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(
    req,
    "hire_issue_credentials",
    typeof rawBody.actorMemberId === "string" ? rawBody.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const body = rawBody as {
    actorMemberId?: string | null;
    displayName?: string;
    roleLabel?: string;
    jobDescription?: string;
    scopes?: string[];
    allowedPurposes?: string[];
    approvalPolicy?: ApprovalPolicy;
    actionLimits?: ActionLimits;
    sodOverrideAcknowledged?: boolean;
    expiresInDays?: number;
    spend?: Partial<SpendLimits> | null;
    allowedAccounts?: AllowedAccount[] | null;
    approvalNotifyEmail?: string | null;
    callbackUrl?: string | null;
    managerId?: string | null;
    voice?: unknown;
    projectAccess?: unknown;
    postingAs?: unknown;
    toolApprovalDefaults?: unknown;
    approvalChannelId?: string | null;
    approverUserIds?: unknown;
  };

  const displayName = (body.displayName || "").trim();
  const roleLabel = (body.roleLabel || "").trim();
  if (!displayName || !roleLabel) {
    return NextResponse.json(policyErrorPayload("name_and_role_required"), { status: 400 });
  }

  const scopes = (body.scopes || []) as EmployeeScope[];
  if (!scopes.length || scopes.some((scope) => !ALL_SCOPES.includes(scope))) {
    return NextResponse.json(policyErrorPayload("scopes_required"), { status: 400 });
  }

  const hasOrder = scopes.includes("commerce:order");
  const spend = hasOrder ? normalizeSpendLimits(body.spend ?? {}) : null;
  const allowedAccounts = normalizeAllowedAccounts(body.allowedAccounts);
  const actionLimits = normalizeActionLimits(body.actionLimits);
  const requestedApprovalPolicy = body.approvalPolicy || "risk_based";
  const toolApprovalDefaults = normalizeToolApprovalDefaults(body.toolApprovalDefaults);
  const orgId = await getCurrentOrgId();
  const sodVerdict = evaluateSod(scopes, await getOrgSodWarnPolicy(orgId));
  if (
    sodAckRequired({
      verdict: sodVerdict,
      requested: requestedApprovalPolicy,
      acknowledged: body.sodOverrideAcknowledged === true,
    })
  ) {
    return NextResponse.json(policyErrorPayload("sod_ack_required"), { status: 400 });
  }

  const secret = issueSecret();
  const expiresInDays = Math.min(365, Math.max(1, body.expiresInDays || 30));
  const expiresAt = new Date(
    Date.now() + expiresInDays * 86400000
  ).toISOString();

  const billingGate = await assertBillingAllows(orgId, "hire");
  if (!billingGate.ok) return billingGate.response;

  try {
    const approvalRoutineText = buildDefaultApprovalRoutine({
      displayName,
    });

    const parsedInbox = parseApprovalChannelId(
      body.approvalChannelId,
      (await listNotificationChannels(orgId)).map((channel) => channel.id)
    );
    if (!parsedInbox.ok) {
      return NextResponse.json(policyErrorPayload("approval_channel_not_found"), { status: 400 });
    }

    const result = await issueEmployee({
      orgId,
      displayName,
      roleLabel,
      jobDescription: body.jobDescription || "",
      scopes,
      allowedPurposes: body.allowedPurposes || [],
      approvalPolicy: requestedApprovalPolicy,
      toolApprovalDefaults,
      sodOverrideAcknowledged: body.sodOverrideAcknowledged === true,
      actionLimits,
      spend,
      allowedAccounts,
      approvalNotifyEmail: body.approvalNotifyEmail?.trim() || null,
      callbackUrl: body.callbackUrl?.trim() || null,
      approvalRoutineText,
      managerId: body.managerId?.trim() || null,
      voice: body.voice == null ? defaultVoice() : normalizeVoice(body.voice),
      projectAccess:
        body.projectAccess == null
          ? defaultProjectAccess()
          : normalizeProjectAccess(body.projectAccess),
      postingAs: normalizePostingAs(body.postingAs),
      approvalChannelId: parsedInbox.id,
      approverUserIds: normalizeApproverUserIds(body.approverUserIds),
      secretHash: secret.hash,
      secretPrefix: secret.prefix,
      expiresAt,
      auditSummary: `${displayName} の社員証を発行`,
    });

    const instructionsSnippet = buildHireInstructionsSnippet({
      displayName,
      roleLabel,
      employeeId: result.employee.id,
    });
    const routineText = buildDefaultApprovalRoutine({
      displayName,
      employeeId: result.employee.id,
    });
    if (
      body.sodOverrideAcknowledged &&
      (sodVerdict.level === "force_human" ||
        (sodVerdict.level === "warn" && sodVerdict.domains.length >= 2))
    ) {
      await appendAuditEvent({
        orgId: result.employee.orgId,
        employeeId: result.employee.id,
        credentialId: result.credentialId,
        actorEmail: gate.actor.email,
        action: "employee.sod_override",
        purpose: null,
        summary: "権限集中の警告を確認して発行",
        metadata: {
        acknowledged: true,
        domains: sodVerdict.domains,
        approvalPolicy: result.employee.approvalPolicy,
        toolApprovalDefaults: result.employee.toolApprovalDefaults,
        actor: gate.actor.email,
      },
      });
    }

    return NextResponse.json({
      ok: true,
      demo: result.demo,
      mode: runtimeModeLabel(),
      employee: {
        ...result.employee,
        approvalRoutineText: routineText,
      },
      credential: {
        id: result.credentialId,
        prefix: secret.prefix,
        scopes,
        allowedPurposes: body.allowedPurposes || [],
        approvalPolicy: result.employee.approvalPolicy,
        actionLimits: result.employee.actionLimits,
        spend,
        allowedAccounts,
        expiresAt,
        secretHashAlgo: "sha256",
        oneTimeSecret: secret.raw,
        secretHash: secret.hash.slice(0, 12) + "…",
      },
      binding: result.binding,
      sodVerdict,
      generation: result.generation,
      hirePack: {
        instructionsSnippet,
        routineText,
        noticeJa:
          "needs_approval 時は作業を止め、署名付き status poll URL を承認/却下まで待つ。Partner webhook が来るまで poll が必須です。",
      },
      notice:
        "この秘密値は一度だけ表示されます。Grok Bot 側の連携設定に貼り付け、安全に保管してください。employeeId は生涯不変です。Instructions / Routine の承認待ちルールも必ず貼ってください。",
      actorId: gate.actor.id,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : "issue_failed";
    const code = raw in POLICY_ERROR_MESSAGES ? raw : "issue_failed";
    return NextResponse.json(policyErrorPayload(code), { status: 500 });
  }
}
