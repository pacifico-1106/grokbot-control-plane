/**
 * LP Handoff API
 * 
 * POST /api/lp/handoff - Create handoff request (from chat tool)
 * GET /api/lp/handoff?id=xxx - Get handoff for confirmation page
 * PUT /api/lp/handoff - Confirm handoff with optional edits
 * DELETE /api/lp/handoff?id=xxx - Cancel handoff
 * 
 * Feature flag: LP_HANDOFF_ENABLED (default OFF)
 */

import { NextRequest, NextResponse } from "next/server";
import { isLpHandoffEnabled } from "@/lib/feature-flags";
import {
  createHandoff,
  getHandoff,
  confirmHandoff,
  cancelHandoff,
} from "@/lib/lp/handoffs";
import { enqueueHandoffNotification } from "@/lib/lp/outbox-processor";
import { resolveGuestJourney, type GuestSessionResult } from "@/lib/lp/guest-session";
import { hashIp } from "@/lib/lp/rate-limit";
import { IP_HASH_UNAVAILABLE, isIpHashKeyConfigured } from "@/lib/security/ip-hash-key";
import { createHash } from "node:crypto";

function sessionError(session: Extract<GuestSessionResult, { ok: false }>) {
  const body = "message" in session ? { error: session.error, message: session.message } : { error: session.error };
  return NextResponse.json(body, { status: session.status });
}

const NOT_FOUND = { error: "not_found", message: "Handoff not found" } as const;

function hashUserAgent(ua: string): string {
  return createHash("sha256").update(ua).digest("hex").slice(0, 32);
}

function validateEmail(email: string): boolean {
  if (!email || email.length > 320) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePhone(phone: string): boolean {
  if (!phone || phone.length > 50) return false;
  const cleaned = phone.replace(/[\s\-\(\)]/g, "");
  return /^[\d+]+$/.test(cleaned) && cleaned.length >= 10;
}

export async function POST(request: NextRequest) {
  if (!isLpHandoffEnabled()) {
    return NextResponse.json(
      { error: "feature_disabled", message: "Handoff feature is not enabled" },
      { status: 404 }
    );
  }

  const session = await resolveGuestJourney(request, { requireCsrf: true });
  if (!session.ok) return sessionError(session);
  const journeyId = session.journey.id;

  try {
    const body = await request.json();
    const { reason, summaryDraft } = body;

    if (!reason || typeof reason !== "string" || reason.length > 500) {
      return NextResponse.json(
        { error: "invalid_input", message: "reason is required (max 500 chars)" },
        { status: 400 }
      );
    }

    if (!summaryDraft || typeof summaryDraft !== "string" || summaryDraft.length > 2000) {
      return NextResponse.json(
        { error: "invalid_input", message: "summaryDraft is required (max 2000 chars)" },
        { status: 400 }
      );
    }

    if (!isIpHashKeyConfigured()) {
      console.error("[lp/handoff] IP_HASH_KEY not configured; refusing");
      return NextResponse.json({ ...IP_HASH_UNAVAILABLE }, { status: 503 });
    }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    const handoff = await createHandoff({
      journeyId,
      reason,
      summaryDraft,
      ipHash: hashIp(ip),
      userAgentHash: hashUserAgent(userAgent),
    });

    if (!handoff) {
      return NextResponse.json(
        { error: "creation_failed", message: "Failed to create handoff request" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      id: handoff.id,
      status: handoff.status,
      confirmUrl: `/lp/ai-employee/handoff/confirm?id=${handoff.id}`,
    });
  } catch (error) {
    console.error("[handoff] POST error:", error);
    return NextResponse.json(
      { error: "internal_error", message: "An error occurred" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  if (!isLpHandoffEnabled()) {
    return NextResponse.json(
      { error: "feature_disabled", message: "Handoff feature is not enabled" },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const handoffId = searchParams.get("id");

  if (!handoffId) {
    return NextResponse.json(
      { error: "invalid_input", message: "id is required" },
      { status: 400 }
    );
  }

  const session = await resolveGuestJourney(request, { requireCsrf: false });
  if (!session.ok) return sessionError(session);

  const handoff = await getHandoff(handoffId);

  // Another guest's handoff is reported as not found, so ids cannot be probed.
  if (!handoff || handoff.journeyId !== session.journey.id) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  return NextResponse.json({
    id: handoff.id,
    status: handoff.status,
    reason: handoff.reason,
    summaryDraft: handoff.summaryDraft,
    createdAt: handoff.createdAt,
  });
}

export async function PUT(request: NextRequest) {
  if (!isLpHandoffEnabled()) {
    return NextResponse.json(
      { error: "feature_disabled", message: "Handoff feature is not enabled" },
      { status: 404 }
    );
  }

  try {
    const body = await request.json();
    const { handoffId, summaryFinal, contactEmail, contactPhone, contactNotes } = body;

    if (!handoffId || typeof handoffId !== "string") {
      return NextResponse.json(
        { error: "invalid_input", message: "handoffId is required" },
        { status: 400 }
      );
    }

    if (!summaryFinal || typeof summaryFinal !== "string" || summaryFinal.length > 2000) {
      return NextResponse.json(
        { error: "invalid_input", message: "summaryFinal is required (max 2000 chars)" },
        { status: 400 }
      );
    }

    if (contactEmail && !validateEmail(contactEmail)) {
      return NextResponse.json(
        { error: "invalid_input", message: "Invalid email format" },
        { status: 400 }
      );
    }

    if (contactPhone && !validatePhone(contactPhone)) {
      return NextResponse.json(
        { error: "invalid_input", message: "Invalid phone format" },
        { status: 400 }
      );
    }

    const session = await resolveGuestJourney(request, { requireCsrf: true });
    if (!session.ok) return sessionError(session);
    const existing = await getHandoff(handoffId);
    if (!existing || existing.journeyId !== session.journey.id) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    const confirmedHandoff = await confirmHandoff({
      handoffId,
      summaryFinal,
      contactEmail: contactEmail || undefined,
      contactPhone: contactPhone || undefined,
      contactNotes: contactNotes?.slice(0, 500) || undefined,
    });

    if (!confirmedHandoff) {
      return NextResponse.json(
        { error: "confirmation_failed", message: "Failed to confirm handoff (may already be confirmed or cancelled)" },
        { status: 400 }
      );
    }

    await enqueueHandoffNotification(confirmedHandoff);

    return NextResponse.json({
      id: confirmedHandoff.id,
      status: confirmedHandoff.status,
      confirmedAt: confirmedHandoff.confirmedAt,
      message: "ご依頼を受け付けました。担当者からご連絡いたします。",
    });
  } catch (error) {
    console.error("[handoff] PUT error:", error);
    return NextResponse.json(
      { error: "internal_error", message: "An error occurred" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!isLpHandoffEnabled()) {
    return NextResponse.json(
      { error: "feature_disabled", message: "Handoff feature is not enabled" },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const handoffId = searchParams.get("id");

  if (!handoffId) {
    return NextResponse.json(
      { error: "invalid_input", message: "id is required" },
      { status: 400 }
    );
  }

  const session = await resolveGuestJourney(request, { requireCsrf: true });
  if (!session.ok) return sessionError(session);
  const existing = await getHandoff(handoffId);
  if (!existing || existing.journeyId !== session.journey.id) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const success = await cancelHandoff(handoffId);

  if (!success) {
    return NextResponse.json(
      { error: "cancellation_failed", message: "Failed to cancel handoff" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    id: handoffId,
    status: "cancelled",
    message: "キャンセルしました。",
  });
}
