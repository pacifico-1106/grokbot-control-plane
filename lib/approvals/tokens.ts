import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque status token for signed poll URLs (not a session cookie). */
export function generateStatusToken(): string {
  return `st_${randomBytes(24).toString("base64url")}`;
}

/** Compact, random Telegram callback reference (12 hex chars / 48 bits). */
export function generateTelegramRef(): string {
  return randomBytes(6).toString("hex");
}

export function hashStatusToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function statusTokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = Buffer.from(hashStatusToken(a), "hex");
  const hb = Buffer.from(hashStatusToken(b), "hex");
  if (ha.length !== hb.length) return false;
  try {
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

/** Canonical public Staffpass host for MCP + Bot poll URLs. */
export const STAFFPASS_PUBLIC_ORIGIN = "https://staffpass.sealith.com";

/** Public app origin for poll URLs (prod / local). */
export function getAppOrigin(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  // Production: prefer documented Staffpass host over ephemeral *.vercel.app
  // so Bot / MCP pollUrl stays stable across deploys.
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  ) {
    return STAFFPASS_PUBLIC_ORIGIN;
  }
  const prodHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (prodHost) {
    if (prodHost.includes("staffpass") || prodHost.includes("sealith")) {
      return `https://${prodHost}`;
    }
    return STAFFPASS_PUBLIC_ORIGIN;
  }
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }
  return "http://localhost:3000";
}

export function buildPollPath(approvalId: string, statusToken: string): string {
  const q = new URLSearchParams({ id: approvalId, token: statusToken });
  return `/api/approvals/status?${q.toString()}`;
}

export function buildPollUrl(approvalId: string, statusToken: string): string {
  return `${getAppOrigin()}${buildPollPath(approvalId, statusToken)}`;
}
