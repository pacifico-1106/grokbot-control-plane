import { NextResponse } from "next/server";
import { requireAuthenticatedOrg } from "@/lib/auth/require-org";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { isDemoMode } from "@/lib/mode";
import { TRIAL_DAYS } from "@/lib/stripe";

/**
 * Legacy trial form (email stub + redirect).
 * Production signup with Auth+org: use POST /api/auth/signup (see /signup page).
 * Closed as an unauthenticated relay: requires Auth user + org.
 */
export async function POST(req: Request) {
  const gate = await requireAuthenticatedOrg();
  if (!gate.ok) return gate.response;

  const form = await req.formData();
  const orgName = String(form.get("orgName") || "新しい組織");
  const email = String(form.get("email") || gate.session.email || "");
  const mode = String(form.get("mode") || "managed");

  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  await sendWelcomeEmail(email, orgName);
  await sendTrialStartedEmail(email, TRIAL_DAYS);

  const url = new URL("/app", req.url);
  url.searchParams.set("trial", "1");
  url.searchParams.set("mode", mode);
  if (isDemoMode()) url.searchParams.set("demo", "1");
  return NextResponse.redirect(url, 303);
}
