import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  SLACK_BOT_INSTALL_COOKIE,
  signSlackBotInstallState,
  slackBotInstallAuthorizeUrl,
  slackOAuthConfigured,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";

/**
 * Bot-install OAuth start.
 *
 * Tenant admin (owner/admin) starts Slack app workspace installation.
 * Unlike employee identity OAuth, this flow installs the bot token (xoxb)
 * for the org's conversation adapter — no employeeId is involved.
 */
export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  if (!slackOAuthConfigured()) {
    return NextResponse.json(
      { error: "slack_oauth_unconfigured", message: "Slack アプリの OAuth が未設定" },
      { status: 503 }
    );
  }
  const nonce = randomBytes(16).toString("base64url");
  try {
    const state = signSlackBotInstallState({ orgId: gate.orgId, nonce });
    const jar = await cookies();
    jar.set(SLACK_BOT_INSTALL_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });
    return NextResponse.redirect(slackBotInstallAuthorizeUrl(state));
  } catch {
    return NextResponse.json(
      { error: "slack_oauth_unconfigured", message: "Slack アプリの OAuth が未設定" },
      { status: 503 }
    );
  }
}
