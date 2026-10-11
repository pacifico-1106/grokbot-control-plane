/**
 * Consent CSRF token: HMAC-SHA256(secret, "consent|" + rid + "|" + userId + "|" + exp).
 * Bound to the authorization request AND the signed-in user, short-lived.
 * Never logged; only ever rendered into the consent form.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSENT_CSRF_TTL_SEC = 600;

function sign(secret: string, rid: string, userId: string, exp: number): string {
  return createHmac("sha256", secret).update(`consent|${rid}|${userId}|${exp}`).digest("base64url");
}

export function mintConsentCsrf(secret: string, rid: string, userId: string, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + CONSENT_CSRF_TTL_SEC;
  return `${exp}.${sign(secret, rid, userId, exp)}`;
}

export function verifyConsentCsrf(secret: string, token: string, rid: string, userId: string, now = new Date()): boolean {
  if (!token || !rid || !userId) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isInteger(exp) || exp < Math.floor(now.getTime() / 1000)) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, rid, userId, exp));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
