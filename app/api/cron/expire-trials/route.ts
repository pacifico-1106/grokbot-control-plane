import { NextResponse } from "next/server";
import { expireTrials } from "@/lib/data/subscriptions";
import { appendAuditEvent } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily cron job to expire trialing subscriptions where trial_ends_at < now.
 * Grace period: 0 days.
 * Soft-locks: hire/team + confirm-class Gateway invokes (mail.send, comm.reply, calendar.confirm, sns.publish, commerce.*).
 * Keeps: view + approval poll.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_not_configured" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await expireTrials();

    for (const orgId of result.expiredOrgIds) {
      await appendAuditEvent({
        orgId,
        employeeId: null,
        credentialId: null,
        action: "billing.updated",
        purpose: null,
        summary: "トライアル期間が終了しました（status: expired）",
        metadata: {
          previousStatus: "trialing",
          newStatus: "expired",
          trigger: "cron/expire-trials",
        },
      }).catch(() => null);
    }

    return NextResponse.json({
      ok: true,
      expiredCount: result.expiredCount,
      expiredOrgIds: result.expiredOrgIds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
