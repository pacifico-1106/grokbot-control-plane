/**
 * Per-employee LINE official account webhook (LINE PoC L-4). All logic and the
 * security order live in lib/comm/line-ingress.ts. Flag LINE_CONVERSATION_ENABLED
 * (default OFF → 404, nothing read).
 *
 * 木村 10/12 hardening: the body is read as raw bytes, capped at 1 MB while
 * streaming (a Content-Length over 1 MB is refused up front), and the signature
 * is verified over exactly those bytes.
 */
import { handleLineAccountWebhook } from "@/lib/comm/line-ingress";
import { getActiveCommAccountByWebhookRef } from "@/lib/comm/accounts";
import { isLineConversationEnabled } from "@/lib/comm/flags";
import { readBodyCapped } from "@/lib/http/read-body-capped";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;

type RefLookup = typeof getActiveCommAccountByWebhookRef;
let lookupRef: RefLookup = getActiveCommAccountByWebhookRef;
/** Tests only. */
export function __setLineWebhookRefLookupForTests(fn: RefLookup | null): void {
  lookupRef = fn ?? getActiveCommAccountByWebhookRef;
}

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  if (!isLineConversationEnabled()) return jsonUtf8({ ok: false, error: "not_found" }, { status: 404 });
  const { ref } = await ctx.params;
  let account;
  try {
    account = await lookupRef(ref);
  } catch {
    return jsonUtf8({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (!account) return jsonUtf8({ ok: false, error: "not_found" }, { status: 404 });
  const body = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? jsonUtf8({ ok: false, error: "too_large" }, { status: 413 })
      : jsonUtf8({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const r = await handleLineAccountWebhook({ ref, rawBody: body.bytes, signature: req.headers.get("x-line-signature") || "" });
  return jsonUtf8(r.body, { status: r.status });
}
