import { getNotificationChannelByWebhookRef } from "@/lib/data";
import { handleLineApprovalEvents } from "@/lib/line/approval-events";
import { verifyLineSignature } from "@/lib/notify/line";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const channel = await getNotificationChannelByWebhookRef("line", ref);
  // G3: an unknown or disabled ref is a wrong Webhook URL. Answer non-2xx so the
  // LINE Developers「検証」button fails instead of reporting success. The body is
  // not read and no channel data is revealed.
  if (!channel) return jsonUtf8({ ok: false, error: "not_found" }, { status: 404 });
  const rawBody = await req.text();
  if (!verifyLineSignature(channel, rawBody, req.headers.get("x-line-signature") || "")) {
    return jsonUtf8({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { events?: Array<Record<string, unknown>> };
  try {
    body = JSON.parse(rawBody || "{}") as { events?: Array<Record<string, unknown>> };
  } catch {
    return jsonUtf8({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  await handleLineApprovalEvents(channel, body.events || []);
  return jsonUtf8({ ok: true });
}
