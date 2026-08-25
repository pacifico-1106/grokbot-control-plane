import { NextResponse } from "next/server";
import { requireAuthenticatedOrg } from "@/lib/auth/require-org";
import {
  sendApprovalNeededEmail,
  sendBillingEmail,
  sendTrialEndingEmail,
  sendTrialStartedEmail,
  sendWelcomeEmail,
} from "@/lib/email";

/** Dev / stub endpoint to exercise Resend helpers. Requires Auth user + org. */
export async function POST(req: Request) {
  const gate = await requireAuthenticatedOrg();
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    to?: string;
  };
  const to = body.to || gate.session.email || "owner@example.com";
  const kind = body.kind || "welcome";

  let result;
  switch (kind) {
    case "trial":
      result = await sendTrialStartedEmail(to, Number(process.env.TRIAL_DAYS || 14));
      break;
    case "trial_ending":
      result = await sendTrialEndingEmail(to, "デモ組織", 3);
      break;
    case "approval_needed":
    case "approval_requested":
      result = await sendApprovalNeededEmail(to, "デモ承認リクエスト", "high");
      break;
    case "billing":
      result = await sendBillingEmail(to, "お支払いのご案内", "<p>請求スタブです。</p>");
      break;
    default:
      result = await sendWelcomeEmail(to, "デモ組織");
  }

  return NextResponse.json(result);
}
