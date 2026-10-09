/**
 * POST /api/journeys
 * 
 * Create a new LP chat journey with AI disclosure and privacy consent.
 * Returns a CSRF token and sets a signed HttpOnly guest cookie.
 * 
 * Feature flag LP_CHAT_ENABLED must be ON.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isLpChatEnabled } from "@/lib/feature-flags";
import {
  createJourney,
  generateGuestToken,
  generateCsrfToken,
  formatGuestCookieValue,
} from "@/lib/lp/journeys";
import { verifyTurnstileToken, getClientIp, getTurnstileConfig } from "@/lib/lp/turnstile";
import { hashIp, checkRateLimits } from "@/lib/lp/rate-limit";
import { IP_HASH_UNAVAILABLE, isIpHashKeyConfigured } from "@/lib/security/ip-hash-key";
import { getPublishedRelease } from "@/lib/lp/knowledge-base";

const GUEST_COOKIE_NAME = "lp_guest";
const CSRF_COOKIE_NAME = "lp_csrf";

function isLpBotProtectionEnabled(): boolean {
  const v = (process.env.LP_INQUIRY_BOT_PROTECTION_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export async function POST(req: Request) {
  if (!isLpChatEnabled()) {
    return NextResponse.json(
      { ok: false, error: "feature_disabled", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey.startsWith("replace_me")) {
    return NextResponse.json(
      { ok: false, error: "chat_unavailable", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const clientIp = getClientIp(req);
  const botProtectionEnabled = isLpBotProtectionEnabled();

  // IP_HASH_KEY required (no dev fallback): refuse before rate limiting or any write.
  if (clientIp && !isIpHashKeyConfigured()) {
    console.error("[journeys] IP_HASH_KEY not configured; refusing");
    return NextResponse.json({ ok: false, ...IP_HASH_UNAVAILABLE }, { status: 503 });
  }

  if (botProtectionEnabled && clientIp) {
    const ipHash = hashIp(clientIp);
    const rateLimitResult = checkRateLimits(ipHash, {
      windowMs: 60000,
      maxRequests: 10,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", message: "リクエストが多すぎます" },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds || 60) },
        }
      );
    }
  }

  let body: {
    aiDisclosureAccepted?: boolean;
    privacyVersion?: string;
    turnstileToken?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { aiDisclosureAccepted, privacyVersion, turnstileToken } = body;

  if (!aiDisclosureAccepted) {
    return NextResponse.json(
      { ok: false, error: "consent_required", message: "AI相談窓口の利用にはAI表示への同意が必要です" },
      { status: 400 }
    );
  }

  if (!privacyVersion) {
    return NextResponse.json(
      { ok: false, error: "privacy_required", message: "プライバシーポリシーへの同意が必要です" },
      { status: 400 }
    );
  }

  if (botProtectionEnabled) {
    const turnstileConfig = getTurnstileConfig();

    if (turnstileConfig) {
      if (!turnstileToken) {
        return NextResponse.json(
          { ok: false, error: "turnstile_required", message: "認証が必要です" },
          { status: 400 }
        );
      }

      const turnstileResult = await verifyTurnstileToken(turnstileToken, clientIp);

      if (!turnstileResult.success) {
        console.warn("[journeys] Turnstile verification failed:", turnstileResult.errorCodes);
        return NextResponse.json(
          { ok: false, error: "turnstile_failed", message: "認証に失敗しました" },
          { status: 400 }
        );
      }
    }
  }

  const kbRelease = await getPublishedRelease();
  const { token, tokenHash } = generateGuestToken();
  const csrfToken = generateCsrfToken();
  const ipHash = clientIp ? hashIp(clientIp) : undefined;

  const journey = await createJourney({
    tokenHash,
    aiDisclosureAccepted: true,
    privacyVersion,
    kbReleaseId: kbRelease?.releaseId,
    ipHash,
  });

  if (!journey) {
    return NextResponse.json(
      { ok: false, error: "journey_creation_failed", message: "セッションの作成に失敗しました" },
      { status: 500 }
    );
  }

  const cookieStore = await cookies();
  // cookies().set() takes the bare value. Passing the full Set-Cookie string from
  // formatGuestCookie() stored "lp_guest=<token>.<sig>; Path=/; ..." as the value,
  // so every later signature check failed with invalid_session.
  const guestCookieValue = formatGuestCookieValue(token);

  cookieStore.set(GUEST_COOKIE_NAME, guestCookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60,
  });

  cookieStore.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60,
  });

  return NextResponse.json(
    {
      ok: true,
      journeyId: journey.id,
      csrfToken,
      expiresAt: journey.expiresAt,
      capabilities: {
        chat: true,
        handoff: true,
        purchase: false,
      },
      kbReleaseId: journey.kbReleaseId,
    },
    { status: 201 }
  );
}
