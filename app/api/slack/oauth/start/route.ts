import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { isBrowserNavigation, requireIdentityLinkManager } from "@/lib/auth/identity-link-gate";
import { getEmployee } from "@/lib/data";
import {
  SLACK_OAUTH_COOKIE,
  signSlackOAuthState,
  slackAuthorizeUrl,
  slackOAuthConfigured,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";

/**
 * Starts linking an AI employee's Slack user identity (session flow).
 * 401 no session; 403 without hire_issue_credentials (a browser navigation is
 * sent back to the employee page with ?slack=forbidden instead of raw JSON);
 * 404 for an employee outside the caller's org. The signed state is bound to
 * the initiating member, org and employee; the callback re-checks all three.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId")?.trim() || "";
  const gate = await requireIdentityLinkManager(req);
  if (!gate.ok) {
    if (gate.status === 403 && isBrowserNavigation(req)) {
      const dest = new URL(
        employeeId ? `/app/employees/${encodeURIComponent(employeeId)}` : "/app/employees",
        getAppOrigin()
      );
      dest.searchParams.set("slack", "forbidden");
      return NextResponse.redirect(dest, 303);
    }
    return gate.response;
  }
  if (!slackOAuthConfigured()) {
    return NextResponse.json(
      { error: "slack_oauth_unconfigured", message: "Slack アプリの OAuth が未設定" },
      { status: 503 }
    );
  }
  if (!employeeId) {
    return NextResponse.json({ error: "employee_id_required" }, { status: 400 });
  }
  const employee = await getEmployee(employeeId, gate.orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const nonce = randomBytes(16).toString("base64url");
  try {
    const state = signSlackOAuthState({
      orgId: gate.orgId,
      employeeId,
      nonce,
      actorMemberId: gate.actor.id,
    });
    const jar = await cookies();
    jar.set(SLACK_OAUTH_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });
    return NextResponse.redirect(slackAuthorizeUrl(state));
  } catch {
    return NextResponse.json(
      { error: "slack_oauth_unconfigured", message: "Slack アプリの OAuth が未設定" },
      { status: 503 }
    );
  }
}
