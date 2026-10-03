import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { bindEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { authorizeLinkHtmlResponse, authorizeLinkPageKind, completeAuthorizeLinkCallback } from "@/lib/slack/authorize-link";
import { syncAutoDmRoutesForEmployee } from "@/lib/slack/dm-autoroute";
import { isSlackDmAutorouteEnabled } from "@/lib/slack/dm-autoroute-flags";
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

/**
 * SLACK_DM_AUTOROUTE_ENABLED (default OFF): install internal-party DM routes
 * after the response. Outcome is audited only; the response never changes.
 * Shared by the session flow and the re-authorize link flow.
 */
function scheduleDmAutoroute(orgId: string, employeeId: string): void {
  if (!isSlackDmAutorouteEnabled()) return;
  const job = () =>
    syncAutoDmRoutesForEmployee({ orgId, employeeId, trigger: "identity_linked" }).then(() => undefined);
  try {
    after(job);
  } catch {
    void job().catch(() => undefined);
  }
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
  if (parsed.linkId) {
    // SLACK_AUTHORIZE_LINK_ENABLED: re-authorize link (single use, pinned Slack
    // user / team). Fails closed when the flag is OFF; never falls through to
    // the session flow below.
    const result = await completeAuthorizeLinkCallback({
      state: { orgId: parsed.orgId, employeeId: parsed.employeeId, linkId: parsed.linkId },
      code,
      oauthError,
      exchange: exchangeCode,
      authTest,
    }).catch(() => ({ ok: false as const, code: "error", consumed: false }));
    if (!result.ok) {
      // Every consumed failure → "burned" (same template as the DM notice, only
      // the reason code varies; never shows the other account's U…).
      const kind = authorizeLinkPageKind(result.code);
      return authorizeLinkHtmlResponse(kind, kind === "denied" ? 200 : 400, result.code);
    }
    scheduleDmAutoroute(result.orgId, result.employeeId);
    return authorizeLinkHtmlResponse("ok");
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
    scheduleDmAutoroute(parsed.orgId, parsed.employeeId);
    return redirectEmployee(parsed.employeeId, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "slack_identity_mismatch") {
      return redirectEmployee(parsed.employeeId, "mismatch");
    }
    return redirectEmployee(parsed.employeeId, "error");
  }
}
