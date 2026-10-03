import { NextResponse } from "next/server";
import { handleSharedApprovalAppEvent } from "@/lib/slack/shared-approval-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SLACK_SHARED_APPROVAL_APP_ENABLED: Events Request URL of 「Staffpass承認」 (see lib/slack/shared-approval-events.ts). */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const result = await handleSharedApprovalAppEvent({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp") || "",
    signature: req.headers.get("x-slack-signature") || "",
  });
  return NextResponse.json(result.body, { status: result.status });
}
