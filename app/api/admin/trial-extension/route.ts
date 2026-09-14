import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { extendTrial, getSubscription } from "@/lib/data/subscriptions";
import { appendAuditEvent } from "@/lib/data";

export const runtime = "nodejs";

/**
 * POST /api/admin/trial-extension
 * Super admin only — extend trial_ends_at and set status back to trialing.
 * Does NOT bypass tenant billing gates — only extends the trial period.
 * Requires audit log entry.
 */
export async function POST(req: Request) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: access.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  let body: { orgId?: string; newTrialEndsAt?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  const orgId = (body.orgId || "").trim();
  const newTrialEndsAt = (body.newTrialEndsAt || "").trim();
  const reason = (body.reason || "").trim();

  if (!orgId) {
    return NextResponse.json(
      { ok: false, error: "org_id_required" },
      { status: 400 }
    );
  }

  if (!newTrialEndsAt) {
    return NextResponse.json(
      { ok: false, error: "new_trial_ends_at_required" },
      { status: 400 }
    );
  }

  const parsedDate = new Date(newTrialEndsAt);
  if (isNaN(parsedDate.getTime())) {
    return NextResponse.json(
      { ok: false, error: "invalid_date_format" },
      { status: 400 }
    );
  }

  if (parsedDate.getTime() < Date.now()) {
    return NextResponse.json(
      { ok: false, error: "date_must_be_in_future" },
      { status: 400 }
    );
  }

  const currentSub = await getSubscription(orgId);
  const previousStatus = currentSub?.status || "none";
  const previousTrialEndsAt = currentSub?.trialEndsAt || null;

  try {
    const updated = await extendTrial(orgId, parsedDate.toISOString());

    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "billing.updated",
      purpose: null,
      summary: `トライアル期間を延長しました（${access.actor.email}）`,
      metadata: {
        adminAction: "extend_trial",
        adminEmail: access.actor.email,
        previousStatus,
        newStatus: "trialing",
        previousTrialEndsAt,
        newTrialEndsAt: parsedDate.toISOString(),
        reason: reason || null,
      },
    });

    return NextResponse.json({
      ok: true,
      subscription: updated
        ? {
            orgId: updated.orgId,
            status: updated.status,
            trialEndsAt: updated.trialEndsAt,
            planKey: updated.planKey,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
