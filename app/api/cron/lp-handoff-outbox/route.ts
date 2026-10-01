/**
 * LP Handoff Outbox Processing Cron
 * 
 * POST /api/cron/lp-handoff-outbox - Process pending handoff notifications
 * 
 * Called by Vercel Cron or external scheduler.
 * Requires CRON_SECRET for authentication.
 * 
 * Feature flag: LP_HANDOFF_ENABLED (default OFF)
 */

import { NextRequest, NextResponse } from "next/server";
import { isLpHandoffEnabled } from "@/lib/feature-flags";
import { processHandoffOutbox, type OutboxEntry } from "@/lib/lp/outbox-processor";

function validateCronSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret) {
    console.warn("[lp-handoff-outbox] CRON_SECRET not configured");
    return false;
  }

  if (authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  const secretHeader = request.headers.get("x-cron-secret");
  return secretHeader === cronSecret;
}

async function sendHandoffNotification(entry: OutboxEntry): Promise<{ success: boolean; error?: string }> {
  const notifyEmail = process.env.LP_HANDOFF_NOTIFY_EMAIL;
  const notifySlackWebhook = process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;

  if (!notifyEmail && !notifySlackWebhook) {
    console.warn("[lp-handoff-outbox] No notification destination configured");
    return { success: false, error: "no_destination_configured" };
  }

  const payload = entry.payload;
  const summary = payload.summary as string || "";
  const reason = payload.reason as string || "";
  const contactEmail = payload.contactEmail as string || null;
  const contactPhone = payload.contactPhone as string || null;
  const contactNotes = payload.contactNotes as string || null;
  const handoffId = payload.handoffId as string || "";

  const messageLines = [
    "【AI社員LP】お問い合わせ引継ぎ",
    "",
    `引継ぎID: ${handoffId}`,
    `理由: ${reason}`,
    "",
    "■ 会話サマリー:",
    summary,
    "",
    "■ 連絡先情報:",
    contactEmail ? `Email: ${contactEmail}` : "Email: (未入力)",
    contactPhone ? `Tel: ${contactPhone}` : "Tel: (未入力)",
    contactNotes ? `備考: ${contactNotes}` : "",
  ].filter(Boolean).join("\n");

  if (notifySlackWebhook) {
    try {
      const response = await fetch(notifySlackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: messageLines,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("[lp-handoff-outbox] Slack webhook failed:", text);
        return { success: false, error: `slack_webhook_failed: ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "unknown";
      console.error("[lp-handoff-outbox] Slack webhook error:", errorMsg);
      return { success: false, error: `slack_webhook_error: ${errorMsg}` };
    }
  }

  if (notifyEmail) {
    console.log("[lp-handoff-outbox] Email notification would be sent to:", notifyEmail);
    console.log("[lp-handoff-outbox] Message:", messageLines);
    return { success: true };
  }

  return { success: false, error: "no_handler" };
}

export async function POST(request: NextRequest) {
  if (!validateCronSecret(request)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401 }
    );
  }

  if (!isLpHandoffEnabled()) {
    return NextResponse.json({
      status: "skipped",
      reason: "feature_disabled",
    });
  }

  try {
    const result = await processHandoffOutbox(sendHandoffNotification);

    console.log("[lp-handoff-outbox] Processing result:", result);

    return NextResponse.json({
      status: "completed",
      processed: result.processed,
      delivered: result.delivered,
      failed: result.failed,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error("[lp-handoff-outbox] Processing error:", error);
    return NextResponse.json(
      { error: "processing_failed", message: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return NextResponse.json(
    { error: "method_not_allowed", message: "Use POST to trigger processing" },
    { status: 405 }
  );
}
