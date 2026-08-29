/**
 * Staffpass Slack Event Subscriptions（Cursor Slack は使わない）.
 *
 * Slack API → Staffpass アプリ → Event Subscriptions:
 *   Request URL: https://staffpass.sealith.com/api/webhooks/slack/events
 *   Bot events: app_mention, message.channels, message.groups
 * 署名: 環境変数 SLACK_SIGNING_SECRET。未設定なら承認用 Slack 通知チャネルの signingSecret。
 * Vercel: SLACK_SIGNING_SECRET = Slack アプリ Signing Secret（Basic Information）。
 * SQL: 20260830_slack_mention_ingress.sql を本番 SQL エディタで適用。
 */

import { NextResponse } from "next/server";
import { handleSlackEventsRequest } from "@/lib/slack/mention-ingress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const result = await handleSlackEventsRequest({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp") || "",
    signature: req.headers.get("x-slack-signature") || "",
  });
  return NextResponse.json(result.body, { status: result.status });
}
