/**
 * SLACK_AUTHORIZE_LINK_ENABLED (default OFF): start of the employee Slack
 * re-authorize link. Public (no Staffpass session — the person opening it is
 * signed in to the employee's Slack account). Read-only: the link is consumed
 * only in /api/slack/oauth/callback, so Slack unfurls / prefetches cannot burn it.
 */
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  SLACK_AUTHORIZE_LINK_TOKEN_PARAM,
  authorizeLinkHtmlResponse,
  resolveAuthorizeLinkStart,
} from "@/lib/slack/authorize-link";
import {
  SLACK_OAUTH_COOKIE,
  signSlackOAuthState,
  slackAuthorizeUrl,
  slackOAuthConfigured,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get(SLACK_AUTHORIZE_LINK_TOKEN_PARAM) || "";
  const start = await resolveAuthorizeLinkStart(token);
  if (!start.ok) return authorizeLinkHtmlResponse("invalid", start.code === "authorize_link_flag_off" ? 404 : 410);
  if (!slackOAuthConfigured()) return authorizeLinkHtmlResponse("error", 503);
  const nonce = randomBytes(16).toString("base64url");
  try {
    const state = signSlackOAuthState({
      orgId: start.orgId,
      employeeId: start.employeeId,
      nonce,
      linkId: start.linkId,
    });
    const jar = await cookies();
    jar.set(SLACK_OAUTH_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });
    const response = NextResponse.redirect(slackAuthorizeUrl(state, { teamId: start.expectedTeamId }));
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    return authorizeLinkHtmlResponse("error", 503);
  }
}
