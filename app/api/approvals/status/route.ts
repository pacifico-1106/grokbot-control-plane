import { NextResponse } from "next/server";
import { getApprovalStatusByToken, runtimeModeLabel } from "@/lib/data";

export const runtime = "nodejs";

/**
 * Signed status poll — primary return pipe until Partner webhook exists.
 * Public-ish: requires id + statusToken (not org session).
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
      ? approval.status
      : "pending";

  return NextResponse.json({
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
    /**
     * Bot contract: poll until approved|rejected|expired.
     * Do not complete confirm/send/order while pending.
     */
    pollHint:
      status === "pending"
        ? "continue_polling"
        : status === "approved"
          ? "reinvoke_with_approvalId"
          : "abort_job",
  });
}
