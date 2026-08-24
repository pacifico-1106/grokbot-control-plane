import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque status token for signed poll URLs (not a session cookie). */
export function generateStatusToken(): string {
  return `st_${randomBytes(24).toString("base64url")}`;
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

/** Public app origin for poll URLs (prod / local). */
export function getAppOrigin(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
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
