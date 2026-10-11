/**
 * LP Wake Webhook endpoint
 * 
 * POST /api/webhooks/lp-wake/[path] - Receive webhook triggers
 * 
 * Authentication: X-Webhook-Secret header
 * Idempotency: X-Idempotency-Key header (optional)
 * 
 * Feature flag: LP_WAKE_WEBHOOK_ENABLED (default OFF)
 */

import { hashIp } from "@/lib/lp/rate-limit";
import { IP_HASH_UNAVAILABLE, isIpHashKeyConfigured } from "@/lib/security/ip-hash-key";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isLpWakeWebhookEnabled } from "@/lib/feature-flags";
import {
  validateWebhookRequest,
  recordWebhookEvent,
  updateWebhookEventStatus,
} from "@/lib/lp/wake-webhook";


function hashUserAgent(ua: string): string {
  return createHash("sha256").update(ua).digest("hex").slice(0, 32);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string }> }
) {
  if (!isLpWakeWebhookEnabled()) {
    return NextResponse.json(
      { error: "feature_disabled" },
      { status: 404 }
    );
  }

  const params = await context.params;
  const { path } = params;
  const endpointPath = `/api/webhooks/lp-wake/${path}`;

  const secret = request.headers.get("x-webhook-secret");
  if (!secret) {
    return NextResponse.json(
      { error: "missing_secret", message: "X-Webhook-Secret header is required" },
      { status: 401 }
    );
  }

  const validation = await validateWebhookRequest(endpointPath, secret);
  if (!validation.valid || !validation.config) {
    const status = validation.reason === "endpoint_not_found" ? 404 : 401;
    return NextResponse.json(
      { error: validation.reason },
      { status }
    );
  }

  const config = validation.config;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const eventType = (body.event_type as string) || (body.eventType as string) || "unknown";
  const idempotencyKey = request.headers.get("x-idempotency-key") || undefined;
  
  if (!isIpHashKeyConfigured()) {
    console.error("[lp-wake] IP_HASH_KEY not configured; refusing");
    return NextResponse.json({ ...IP_HASH_UNAVAILABLE }, { status: 503 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";

  const event = await recordWebhookEvent({
    configId: config.id,
    eventType,
    payload: body,
    idempotencyKey,
    ipHash: hashIp(ip),
    userAgentHash: hashUserAgent(userAgent),
  });

  if (!event) {
    return NextResponse.json(
      { error: "event_recording_failed" },
      { status: 500 }
    );
  }

  if (event.status === "duplicate") {
    return NextResponse.json({
      status: "duplicate",
      message: "Event already processed",
      eventId: event.id,
    });
  }

  try {
    switch (config.triggerType) {
      case "journey_resume":
        await updateWebhookEventStatus(event.id, "processed");
        return NextResponse.json({
          status: "processed",
          eventId: event.id,
          message: "Journey resume trigger acknowledged",
        });

      case "notification":
        await updateWebhookEventStatus(event.id, "processed");
        return NextResponse.json({
          status: "processed",
          eventId: event.id,
          message: "Notification trigger acknowledged",
        });

      case "custom":
        await updateWebhookEventStatus(event.id, "processed");
        return NextResponse.json({
          status: "processed",
          eventId: event.id,
          message: "Custom trigger acknowledged",
        });

      default:
        await updateWebhookEventStatus(event.id, "failed", "unknown_trigger_type");
        return NextResponse.json(
          { error: "unknown_trigger_type", eventId: event.id },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("[lp-wake] Processing error:", error);
    await updateWebhookEventStatus(
      event.id,
      "failed",
      error instanceof Error ? error.message.slice(0, 50) : "unknown"
    );
    return NextResponse.json(
      { error: "processing_failed", eventId: event.id },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Allow": "POST, OPTIONS",
    },
  });
}
