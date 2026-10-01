/**
 * Cloudflare Turnstile verification for LP forms.
 * Feature flag LP_INQUIRY_BOT_PROTECTION_ENABLED must be ON.
 */

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
  hostname?: string;
  action?: string;
  cdata?: string;
}

export interface TurnstileConfig {
  secretKey: string;
  siteKey: string;
}

export function getTurnstileConfig(): TurnstileConfig | null {
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim();
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  
  if (!secretKey || secretKey.startsWith("replace_me")) {
    return null;
  }
  if (!siteKey || siteKey.startsWith("replace_me")) {
    return null;
  }
  
  return { secretKey, siteKey };
}

export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string
): Promise<TurnstileVerifyResult> {
  const config = getTurnstileConfig();
  
  if (!config) {
    console.warn("[turnstile] No secret key configured, skipping verification");
    return { success: true, errorCodes: ["not_configured"] };
  }

  if (!token || typeof token !== "string" || token.length > 2048) {
    return { success: false, errorCodes: ["invalid_token_format"] };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", config.secretKey);
    formData.append("response", token);
    if (remoteIp) {
      formData.append("remoteip", remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error("[turnstile] Verification request failed:", response.status);
      return { success: false, errorCodes: ["request_failed"] };
    }

    const result = await response.json() as {
      success: boolean;
      "error-codes"?: string[];
      hostname?: string;
      action?: string;
      cdata?: string;
    };

    return {
      success: result.success,
      errorCodes: result["error-codes"],
      hostname: result.hostname,
      action: result.action,
      cdata: result.cdata,
    };
  } catch (error) {
    console.error("[turnstile] Verification error:", error);
    return { success: false, errorCodes: ["verification_error"] };
  }
}

export function getClientIp(request: Request): string | undefined {
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp;
  
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }
  
  const xRealIp = request.headers.get("x-real-ip");
  if (xRealIp) return xRealIp;
  
  return undefined;
}
