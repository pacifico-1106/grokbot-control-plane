/**
 * Ref lookup: a storage exception is 503 unavailable (LINE will retry).
 * A genuinely unknown ref is 404. Neither reads the body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST, __setLineWebhookRefLookupForTests } from "@/app/api/webhooks/line/c/[ref]/route";

const REF = "A".repeat(43);
const FLAGS = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
});
afterEach(() => {
  __setLineWebhookRefLookupForTests(null);
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function streamed() {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      state.pulled += 1;
      c.enqueue(new Uint8Array(16));
      c.close();
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

describe("LINE webhook ref lookup", () => {
  test("storage exception during ref resolution → 503 unavailable, body never read", async () => {
    __setLineWebhookRefLookupForTests(async () => {
      throw new Error("storage_unavailable");
    });
    const { stream, state } = streamed();
    const req = new Request(`http://localhost/api/webhooks/line/c/${REF}`, {
      method: "POST",
      headers: { "x-line-signature": "x" },
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    const r = await POST(req, { params: Promise.resolve({ ref: REF }) });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(state.pulled).toBe(0);
  });

  test("genuinely unknown ref → 404, body never read", async () => {
    __setLineWebhookRefLookupForTests(async () => null);
    const { stream, state } = streamed();
    const req = new Request(`http://localhost/api/webhooks/line/c/${REF}`, {
      method: "POST",
      headers: { "x-line-signature": "x" },
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    const r = await POST(req, { params: Promise.resolve({ ref: REF }) });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ ok: false, error: "not_found" });
    expect(state.pulled).toBe(0);
  });
});
