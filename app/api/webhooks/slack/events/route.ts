/**
 * Staffpass Slack Event Subscriptions（Cursor Slack は使わない）.
 *
 * Slack API → Staffpass アプリ → Event Subscriptions:
 *   Request URL: https://staffpass.sealith.com/api/webhooks/slack/events
 *   Bot events: app_mention, message.channels, message.groups, message.im
 * message.im は Staffpass アプリ自身とのDMだけ。Botが参加しない人対人DMは届かない。
 * 署名: 環境変数 SLACK_SIGNING_SECRET。未設定なら承認用 Slack 通知チャネルの signingSecret。
 * Vercel: SLACK_SIGNING_SECRET = Slack アプリ Signing Secret（Basic Information）。
 * SQL: 20260830_slack_mention_ingress.sql と 20260903_slack_internal_im_ingress.sql を適用。
 *
 * Slack の 3s 制限に当てないよう、署名検証と url_verification だけ同期し、
 * claim + wake は after() で HTTP 200 の後に回す。
 */

import { after, NextResponse } from "next/server";
import {
  acknowledgeSlackEventsRequest,
  processSlackMentionEnvelope,
} from "@/lib/slack/mention-ingress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const result = await acknowledgeSlackEventsRequest({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp") || "",
    signature: req.headers.get("x-slack-signature") || "",
  });
  if (result.envelope) {
    const envelope = result.envelope;
    after(async () => {
      try {
        await processSlackMentionEnvelope(envelope);
      } catch (error) {
        console.error("slack_events_handle_failed", error);
      }
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}
