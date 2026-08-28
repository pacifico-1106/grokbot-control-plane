import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { bindEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import {
  SLACK_OAUTH_COOKIE,
  slackOAuthRedirectUrl,
  verifySlackOAuthState,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";

function redirectEmployee(employeeId: string, slack: string): NextResponse {
  const dest = new URL(`/app/employees/${encodeURIComponent(employeeId)}`, getAppOrigin());
  dest.searchParams.set("slack", slack);
  return NextResponse.redirect(dest);
}

type SlackOAuthAccess = {
  ok?: boolean;
  error?: string;
  authed_user?: {
    id?: string;
    access_token?: string;
    token?: string;
  };
  team?: { id?: string; name?: string };
  access_token?: string;
};

type SlackAuthTest = {
  ok?: boolean;
  user_id?: string;
  user?: string;
  team_id?: string;
  team?: string;
};

async function exchangeCode(code: string): Promise<SlackOAuthAccess> {
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID?.trim() || "",
    client_secret: process.env.SLACK_CLIENT_SECRET?.trim() || "",
    code,
    redirect_uri: slackOAuthRedirectUrl(),
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const oauthError = url.searchParams.get("error")?.trim() || "";
  const jar = await cookies();
  const nonce = jar.get(SLACK_OAUTH_COOKIE)?.value || "";
  jar.delete(SLACK_OAUTH_COOKIE);

  const parsed = verifySlackOAuthState(state, nonce);
  if (!parsed) {
    return NextResponse.redirect(new URL("/app/employees?slack=error", getAppOrigin()));
  }
  if (oauthError) {
    return redirectEmployee(parsed.employeeId, oauthError === "access_denied" ? "denied" : "error");
  }
  if (!code) {
    return redirectEmployee(parsed.employeeId, "error");
  }

  try {
    const exchanged = await exchangeCode(code);
    if (!exchanged.ok) {
      return redirectEmployee(parsed.employeeId, "error");
    }
    const userToken = (
      exchanged.authed_user?.access_token ||
      exchanged.authed_user?.token ||
      ""
    ).trim();
    if (!userToken || userToken.startsWith("xoxb-")) {
      return redirectEmployee(parsed.employeeId, "error");
    }
    const identity = await authTest(userToken);
    const slackUserId = (identity.user_id || exchanged.authed_user?.id || "").trim();
    if (!identity.ok || !slackUserId) {
      return redirectEmployee(parsed.employeeId, "error");
    }
    await bindEmployeeSlackIdentity({
      employeeId: parsed.employeeId,
      orgId: parsed.orgId,
      slackUserId,
      slackTeamId: identity.team_id || exchanged.team?.id || "",
      displayName: identity.user || exchanged.team?.name || "",
      userToken,
    });
    return redirectEmployee(parsed.employeeId, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "slack_identity_mismatch") {
      return redirectEmployee(parsed.employeeId, "mismatch");
    }
    return redirectEmployee(parsed.employeeId, "error");
  }
}
