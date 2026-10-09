import { publicApproval } from "@/lib/approvals/public";
import { NextResponse } from "next/server";
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { SELF_APPROVAL_DENIED, SELF_APPROVAL_MESSAGE_JA } from "@/lib/admin-mcp/self-approval";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  getApprovalById,
  getEmployee,
  runtimeModeLabel,
} from "@/lib/data";
import { requireCapability } from "@/lib/team/demo-actor";
import { resolveApprovalWithWorkflow } from "@/lib/approvals/workflow-integration";
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import { approverAuthorityNextStepJa, approverAuthorityReplyJa } from "@/lib/approver-authority/reply";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const gate = await requireCapability(req, "approve_actions");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();

  if (!orgId) {
    return NextResponse.json({ error: "org_required" }, { status: 400 });
  }

  let result;
  try {
    result = await resolveApprovalWithWorkflow(id, "approved", gate.actor.email, orgId, {
      actorId: gate.actor.id,
      voterUserId: gate.actor.id || gate.actor.email,
      // PR-D: the signed-in member is the approver to verify (flag ON only; OFF = today's call).
      ...(isApproverAuthorityEnabled() ? { memberId: gate.actor.id } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code || (error instanceof Error ? error.message : "");
    if (code === SELF_APPROVAL_DENIED) {
      return NextResponse.json(
        { error: SELF_APPROVAL_DENIED, message: SELF_APPROVAL_MESSAGE_JA },
        { status: 403 }
      );
    }
    throw error;
  }

  if (!result.ok && result.reason === "approval_not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = result.approval || await getApprovalById(id, orgId);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (result.ok && result.workflowComplete && result.workflowApproved) {
    await fulfillApprovedAdmin(updated);
    await fulfillApprovedInvoke(updated);
  }

  const employee = await getEmployee(updated.employeeId, orgId || updated.orgId);
  const sideEffects = result.ok && result.workflowComplete
    ? await runApprovalResolveSideEffects({
        approval: updated,
        decision: result.workflowApproved ? "approved" : "rejected",
        actorEmail: gate.actor.email,
        employee,
        surface: "web",
      })
    : { notified: [] };

  const response: Record<string, unknown> = {
    ok: result.ok,
    approval: publicApproval(updated),
    sideEffects,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    actorId: gate.actor.id,
    workflowApplied: result.workflowApplied,
    workflowComplete: result.workflowComplete,
  };

  const authorityReply = result.ok && result.workflowComplete ? null : approverAuthorityReplyJa(result.reason);
  if (authorityReply) {
    // PR-D: same wording as Slack / LINE / Telegram.
    response.reason = result.reason;
    response.messageJa = authorityReply;
    const nextStep = approverAuthorityNextStepJa(result.reason);
    if (nextStep) response.nextStepJa = nextStep;
  }

  if (result.progress) {
    response.workflow = {
      instanceId: result.progress.instanceId,
      status: result.progress.status,
      stageId: result.progress.currentStage?.stageId ?? null,
      stageName: result.progress.currentStage?.nameJa ?? null,
      progress: result.progress.currentStage
        ? {
            approved: result.progress.currentStage.approved,
            rejected: result.progress.currentStage.rejected,
            pending: result.progress.currentStage.pending,
            quorum: result.progress.currentStage.quorumDisplay,
          }
        : null,
      finalGoPending: result.progress.finalGoPending,
    };
  }

  return NextResponse.json(response);
}
