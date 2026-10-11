import { handleSharedApprovalAppEvent } from "@/lib/slack/shared-approval-events";
import { jsonUtf8 } from "@/lib/http/json-utf8";

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
  return jsonUtf8(result.body, { status: result.status });
}
