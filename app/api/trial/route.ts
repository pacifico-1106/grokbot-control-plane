import { NextResponse } from "next/server";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { TRIAL_DAYS } from "@/lib/stripe";

export async function POST(req: Request) {
  const form = await req.formData();
  const orgName = String(form.get("orgName") || "新しい組織");
  const email = String(form.get("email") || "");
  const mode = String(form.get("mode") || "managed");

  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  await sendWelcomeEmail(email, orgName);
  await sendTrialStartedEmail(email, TRIAL_DAYS);

  const url = new URL("/app", req.url);
  url.searchParams.set("trial", "1");
  url.searchParams.set("mode", mode);
  return NextResponse.redirect(url, 303);
}
