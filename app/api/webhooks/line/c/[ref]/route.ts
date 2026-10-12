/**
 * Per-employee LINE official account webhook (LINE PoC L-4). All logic and the
 * security order live in lib/comm/line-ingress.ts. Flag LINE_CONVERSATION_ENABLED
 * (default OFF → 404).
 */
import { handleLineAccountWebhook } from "@/lib/comm/line-ingress";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return jsonUtf8({ ok: false, error: "too_large" }, { status: 413 });
  const r = await handleLineAccountWebhook({ ref, rawBody, signature: req.headers.get("x-line-signature") || "" });
  return jsonUtf8(r.body, { status: r.status });
}
