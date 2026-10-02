import { isMcpOAuthEnabled, oauthStateSecret } from "@/lib/mcp-oauth/config";
import { ridBindingSetCookie } from "@/lib/mcp-oauth/browser-binding";
import { handleAuthorizeRequest } from "@/lib/mcp-oauth/authorize";
import { oauthErrorPage, redirect303 } from "@/lib/mcp-oauth/http";
import { OAUTH_RATE_LIMITS, ipHash, rateLimit } from "@/lib/mcp-oauth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth 2.1 authorization endpoint (PR-5). Flag OFF → 404. */
export async function GET(req: Request) {
  if (!isMcpOAuthEnabled()) return new Response("Not Found", { status: 404 });

  const ip = ipHash(req);
  if (!ip) return oauthErrorPage(503, "temporarily_unavailable", "サーバー設定が未完了のため、いまは接続できません。");
  const rl = await rateLimit(`authorize:${ip}`, OAUTH_RATE_LIMITS.authorizePerIpPerMin, 60);
  if (!rl.allowed) {
    const res = oauthErrorPage(429, "slow_down", "リクエストが多すぎます。少し待ってからやり直してください。");
    res.headers.set("Retry-After", String(rl.retryAfterSec));
    return res;
  }

  // Without the state secret the browser cannot be bound to the rid (hardening 2) → fail closed.
  const secret = oauthStateSecret();
  if (!secret) return oauthErrorPage(503, "temporarily_unavailable", "サーバー設定が未完了のため、いまは接続できません。");

  const out = await handleAuthorizeRequest(new URL(req.url));
  if (out.type === "page") return oauthErrorPage(out.status, out.error, out.messageJa);
  if (!out.rid) return redirect303(out.location);
  return redirect303(out.location, { "Set-Cookie": ridBindingSetCookie(secret, out.rid) });
}
