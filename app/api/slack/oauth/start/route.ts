import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import { getEmployee } from "@/lib/data";
import {
  SLACK_OAUTH_COOKIE,
  signSlackOAuthState,
  slackAuthorizeUrl,
  slackOAuthConfigured,
} from "@/lib/slack/oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;
  if (!slackOAuthConfigured()) {
    return NextResponse.json(
      { error: "slack_oauth_unconfigured", message: "Slack アプリの OAuth が未設定" },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId")?.trim() || "";
  if (!employeeId) {
    return NextResponse.json({ error: "employee_id_required" }, { status: 400 });
  }
  const employee = await getEmployee(employeeId, gate.orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const nonce = randomBytes(16).toString("base64url");
  try {
    const state = signSlackOAuthState({ orgId: gate.orgId, employeeId, nonce });
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
