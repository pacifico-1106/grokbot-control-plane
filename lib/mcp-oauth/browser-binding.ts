/**
 * Binds an authorization request (rid) to the browser that started it at
 * GET /oauth/authorize (hardening 2). The consent screen (GET) and decision
 * (POST) require the matching cookie, so a consent URL forwarded to another
 * admin's browser cannot be approved there.
 *
 * Cookie: `__Host-sp_oauth_rb_<sha256(rid)[:16]>` = HMAC-SHA256(MCP_OAUTH_STATE_SECRET, "rid-binding|" + rid)
 * HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age = auth request TTL (600s); no Domain.
 * The rid itself never appears in the cookie name or value. One cookie per rid,
 * so parallel flows in one browser keep working; cookies expire with the request.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AUTH_REQUEST_TTL_SEC } from "@/lib/mcp-oauth/config";
import { sha256Hex } from "@/lib/mcp-oauth/tokens";

export const RID_BINDING_COOKIE_PREFIX = "__Host-sp_oauth_rb_";

export function ridBindingCookieName(rid: string): string {
  return `${RID_BINDING_COOKIE_PREFIX}${sha256Hex(`rid-binding-name|${rid}`).slice(0, 16)}`;
}

export function mintRidBinding(secret: string, rid: string): string {
  return createHmac("sha256", secret).update(`rid-binding|${rid}`).digest("base64url");
}

export function verifyRidBinding(secret: string, rid: string, value: string | null | undefined): boolean {
  if (!secret || !rid || !value) return false;
  const given = Buffer.from(value);
  const expected = Buffer.from(mintRidBinding(secret, rid));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function ridBindingSetCookie(secret: string, rid: string, maxAgeSec = AUTH_REQUEST_TTL_SEC): string {
  return `${ridBindingCookieName(rid)}=${mintRidBinding(secret, rid)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export function ridBindingClearCookie(rid: string): string {
  return `${ridBindingCookieName(rid)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
