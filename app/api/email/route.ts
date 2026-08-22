import { NextResponse } from "next/server";
import {
  sendApprovalNotification,
  sendBillingEmail,
  sendTrialStartedEmail,
  sendWelcomeEmail,
} from "@/lib/email";

/** Dev / stub endpoint to exercise Resend helpers */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    to?: string;
  };
  const to = body.to || "owner@example.com";
  const kind = body.kind || "welcome";

  let result;
  switch (kind) {
    case "trial":
      result = await sendTrialStartedEmail(to, Number(process.env.TRIAL_DAYS || 14));
      break;
    case "approval_requested":
      result = await sendApprovalNotification(to, "approval_requested", "デモ承認リクエスト");
      break;
    case "approval_resolved":
      result = await sendApprovalNotification(to, "approval_resolved", "デモ承認が完了しました");
      break;
    case "billing":
      result = await sendBillingEmail(to, "お支払いのご案内", "<p>請求スタブです。</p>");
      break;
    default:
      result = await sendWelcomeEmail(to, "デモ組織");
  }

  return NextResponse.json(result);
}
