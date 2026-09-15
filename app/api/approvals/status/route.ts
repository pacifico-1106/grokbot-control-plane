import { NextResponse } from "next/server";
import { getApprovalStatusByToken, runtimeModeLabel } from "@/lib/data";
import { getApprovalWorkflowProgress } from "@/lib/approval-workflow";

export const runtime = "nodejs";

/**
 * Signed status poll — primary return pipe until Partner webhook exists.
 * Public-ish: requires id + statusToken (not org session).
 *
 * F8 extension: includes workflow progress when workflow applies.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  const token = (url.searchParams.get("token") || "").trim();

  if (!id || !token) {
    return NextResponse.json(
      {
        ok: false,
        error: "id_and_token_required",
        message: "Query params id and token are required",
      },
      { status: 400 }
    );
  }

  const approval = await getApprovalStatusByToken(id, token);
  if (!approval) {
    return NextResponse.json(
      { ok: false, error: "not_found_or_invalid_token" },
      { status: 404 }
    );
  }

  const status =
    approval.status === "approved" ||
    approval.status === "rejected" ||
    approval.status === "pending" ||
    approval.status === "expired"
    || approval.status === "revision_requested"
      ? approval.status
      : "pending";

  const workflowProgress = await getApprovalWorkflowProgress(approval.id);

  const response: Record<string, unknown> = {
    ok: true,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    approvalId: approval.id,
    status,
    title: approval.title,
    summary: approval.summary,
    tool: approval.tool ?? null,
    purpose: approval.purpose,
    jobId: approval.jobId ?? null,
    risk: approval.risk,
    employeeId: approval.employeeId,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    revisionNote: approval.revisionNote,
    revisionCount: approval.revisionCount,
    parentApprovalId: approval.parentApprovalId,
    pollHint:
      status === "pending"
        ? "continue_polling"
        : status === "approved"
          ? "reinvoke_with_approvalId"
          : status === "revision_requested"
            ? `Revise the artifact per revisionNote and re-invoke with the same jobId and parentApprovalId=${approval.id}.`
          : "abort_job",
  };

  if (workflowProgress) {
    response.workflow = {
      instanceId: workflowProgress.instanceId,
      status: workflowProgress.status,
      stageId: workflowProgress.currentStage?.stageId ?? null,
      stageName: workflowProgress.currentStage?.nameJa ?? null,
      progress: workflowProgress.currentStage
        ? {
            approved: workflowProgress.currentStage.approved,
            rejected: workflowProgress.currentStage.rejected,
            pending: workflowProgress.currentStage.pending,
            quorum: workflowProgress.currentStage.quorumDisplay,
          }
        : null,
      finalGoPending: workflowProgress.finalGoPending,
      stages: workflowProgress.stages.map((s) => ({
        stageId: s.stageId,
        nameJa: s.nameJa,
        approved: s.approved,
        pending: s.pending,
        quorum: s.quorumDisplay,
        quorumMet: s.quorumMet,
      })),
    };
  }

  return NextResponse.json(response);
}
