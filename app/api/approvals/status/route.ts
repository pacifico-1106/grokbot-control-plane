import { NextResponse } from "next/server";
import { getApprovalStatusByToken, runtimeModeLabel } from "@/lib/data";
import { getApprovalWorkflowProgress } from "@/lib/approval-workflow";
import { parseFulfillment } from "@/lib/approvals/fulfill";
import { parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { redactMetadata } from "@/lib/data/redaction";

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

  let fulfillmentResult: Record<string, unknown> | null = null;
  let adminResultRequired = false;
  if (status === "approved") {
    if (isAdminClassApproval(approval)) {
      const adminFulfill = parseAdminFulfillment(approval.metadata);
      if (adminFulfill?.ok) {
        adminResultRequired = Boolean(adminFulfill.oneTimeSecret);
        fulfillmentResult = {
          fulfilled: true,
          tool: adminFulfill.tool,
          ...(adminFulfill.employeeId ? { employeeId: adminFulfill.employeeId } : {}),
          ...(adminFulfill.secretPrefix ? { secretPrefix: adminFulfill.secretPrefix } : {}),
          ...(adminFulfill.orgId ? { orgId: adminFulfill.orgId } : {}),
          ...(adminFulfill.adminAgentId ? { adminAgentId: adminFulfill.adminAgentId } : {}),
          ...(adminFulfill.partyId ? { partyId: adminFulfill.partyId } : {}),
          ...(adminFulfill.channelId ? { channelId: adminFulfill.channelId } : {}),
          ...(adminFulfill.draft ? { draft: adminFulfill.draft } : {}),
          ...(adminFulfill.nextStepJa ? { nextStepJa: adminFulfill.nextStepJa } : {}),
          ...(adminFulfill.noticeJa ? { noticeJa: adminFulfill.noticeJa } : {}),
          ...(adminFulfill.ownerUserId ? { ownerUserId: adminFulfill.ownerUserId } : {}),
          ...(adminFulfill.ownerEmail ? { ownerEmail: adminFulfill.ownerEmail } : {}),
          ...(adminFulfill.trialEndsAt !== undefined ? { trialEndsAt: adminFulfill.trialEndsAt } : {}),
          ...(adminFulfill.integrationMode ? { integrationMode: adminFulfill.integrationMode } : {}),
          ...(adminFulfill.summaryJa ? { summaryJa: adminFulfill.summaryJa } : {}),
        };
      } else if (adminFulfill && !adminFulfill.ok) {
        fulfillmentResult = {
          fulfilled: true,
          ok: false,
          error: adminFulfill.error,
        };
      }
    } else {
      const invokeFulfill = parseFulfillment(approval.metadata);
      if (invokeFulfill?.ok) {
        fulfillmentResult = {
          fulfilled: true,
          delivery: invokeFulfill.delivery,
          ...(invokeFulfill.channel ? { channel: invokeFulfill.channel } : {}),
          ...(invokeFulfill.ts ? { ts: invokeFulfill.ts } : {}),
          ...(invokeFulfill.id ? { id: invokeFulfill.id } : {}),
          ...(invokeFulfill.surface ? { surface: invokeFulfill.surface } : {}),
        };
      } else if (invokeFulfill && !invokeFulfill.ok) {
        fulfillmentResult = {
          fulfilled: true,
          ok: false,
          error: invokeFulfill.error,
        };
      }
    }
  }

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
    ...(fulfillmentResult ? { fulfillment: redactMetadata(fulfillmentResult) } : {}),
    pollHint:
      status === "pending"
        ? "continue_polling"
        : status === "approved"
          ? fulfillmentResult && !adminResultRequired
            ? "fulfilled"
            : "reinvoke_with_approvalId"
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
