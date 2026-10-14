/**
 * Content-Length is digits only. Number() accepted 1e6 / 0x10 / +10 / 12.5
 * as sizes; those must be refused before any byte is read.
 *
 * Uses a fake Request so Fetch cannot rewrite the header (Bun replaces an
 * invalid Content-Length with the known body size).
 */
import { describe, expect, test } from "bun:test";
import { readBodyCapped } from "@/lib/http/read-body-capped";

function req(contentLength: string | null, pulled: { n: number }): Request {
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled.n += 1;
      c.enqueue(new Uint8Array([0x7b]));
      c.close();
    },
  }, { highWaterMark: 0 });
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null) },
    body: stream,
  } as unknown as Request;
}

describe("readBodyCapped Content-Length", () => {
  test("digits-only Content-Length under the cap is accepted", async () => {
    const pulled = { n: 0 };
    const r = await readBodyCapped(req("1", pulled), 100);
    expect(r).toEqual({ ok: true, bytes: new Uint8Array([0x7b]) });
    expect(pulled.n).toBe(1);
  });

  test("non-digit Content-Length is refused (not parsed with Number())", async () => {
    for (const value of ["1e6", "0x10", "+10", "12.5", "10abc", "10,10", " 10", "10 "]) {
      const pulled = { n: 0 };
      const r = await readBodyCapped(req(value, pulled), 1_000_000);
      expect(r).toEqual({ ok: false, reason: "read_error" });
      expect(pulled.n).toBe(0);
    }
  });
});
