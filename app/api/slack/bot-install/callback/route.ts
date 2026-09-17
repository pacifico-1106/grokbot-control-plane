import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appendAuditEvent, upsertConversationAdapter } from "@/lib/data";
import { getAppOrigin } from "@/lib/approvals/tokens";
import {
  SLACK_BOT_INSTALL_COOKIE,
  slackBotInstallRedirectUrl,
  verifySlackBotInstallState,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";

type SlackOAuthAccess = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  team?: { id?: string; name?: string };
  bot_user_id?: string;
};

type SlackAuthTest = {
  ok?: boolean;
  team_id?: string;
  team?: string;
  bot_id?: string;
  user_id?: string;
};

function redirectToResult(status: string, teamName?: string): NextResponse {
  const dest = new URL("/app/slack-bot-install", getAppOrigin());
  dest.searchParams.set("status", status);
  if (teamName) dest.searchParams.set("team", teamName);
  return NextResponse.redirect(dest);
}

async function exchangeCode(code: string): Promise<SlackOAuthAccess> {
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID?.trim() || "",
    client_secret: process.env.SLACK_CLIENT_SECRET?.trim() || "",
    code,
    redirect_uri: slackBotInstallRedirectUrl(),
  });
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  return (await response.json().catch(() => ({}))) as SlackOAuthAccess;
}

async function authTest(token: string): Promise<SlackAuthTest> {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });
  return (await response.json().catch(() => ({}))) as SlackAuthTest;
}

/**
 * Bot-install OAuth callback.
 *
 * Exchanges authorization code for bot token (xoxb-), validates it,
 * and upserts the org conversation adapter with encrypted credentials.
 *
 * Security:
 * - orgId comes ONLY from verified signed state (tenant isolation)
 * - Bot token encrypted at rest via upsertConversationAdapter
 * - Full token never logged or returned in HTML
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const oauthError = url.searchParams.get("error")?.trim() || "";
  const jar = await cookies();
  const nonce = jar.get(SLACK_BOT_INSTALL_COOKIE)?.value || "";
  jar.delete(SLACK_BOT_INSTALL_COOKIE);

  const parsed = verifySlackBotInstallState(state, nonce);
  if (!parsed) {
    console.warn("slack_bot_install_callback: invalid state or nonce");
    return redirectToResult("error_state");
  }
  if (oauthError) {
    console.info(`slack_bot_install_callback: oauth_error=${oauthError} org=${parsed.orgId}`);
    return redirectToResult(oauthError === "access_denied" ? "denied" : "error");
  }
  if (!code) {
    console.warn(`slack_bot_install_callback: missing code org=${parsed.orgId}`);
    return redirectToResult("error");
  }

  try {
    const exchanged = await exchangeCode(code);
    if (!exchanged.ok) {
      console.error(`slack_bot_install_callback: exchange failed org=${parsed.orgId} error=${exchanged.error}`);
      return redirectToResult("error_exchange");
    }
    const botToken = (exchanged.access_token || "").trim();
    if (!botToken || !botToken.startsWith("xoxb-")) {
      console.error(`slack_bot_install_callback: not a bot token org=${parsed.orgId}`);
      return redirectToResult("error_token_type");
    }

    const identity = await authTest(botToken);
    if (!identity.ok) {
      console.error(`slack_bot_install_callback: auth.test failed org=${parsed.orgId}`);
      return redirectToResult("error_auth");
    }
    const teamId = identity.team_id || exchanged.team?.id || "";
    const teamName = identity.team || exchanged.team?.name || teamId;

    await upsertConversationAdapter({
      orgId: parsed.orgId,
      surface: "slack",
      label: teamName ? `Slack (${teamName})` : "Slack 会話投稿",
      enabled: true,
      config: { teamId, teamName, installedAt: new Date().toISOString() },
      secrets: { botToken },
    });
    const tokenPrefix = botToken.slice(0, 12);
    await appendAuditEvent({
      orgId: parsed.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: "slack_bot_install_oauth",
      action: "conversation.adapter_installed",
      purpose: null,
      summary: `Slack ワークスペース「${teamName}」にインストール`,
      metadata: {
        surface: "slack",
        teamId,
        teamName,
        tokenPrefix,
        flow: "bot_install_oauth",
      },
    });

    console.info(`slack_bot_install_callback: success org=${parsed.orgId} team=${teamId}`);
    return redirectToResult("ok", teamName);
  } catch (error) {
    console.error("slack_bot_install_callback: unexpected error", error);
    return redirectToResult("error");
  }
}
