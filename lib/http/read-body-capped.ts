/**
 * Read a request body as RAW BYTES with a hard cap, without buffering more than
 * `maxBytes` (+ one chunk) in memory:
 *  - a declared Content-Length over the cap is refused before anything is read;
 *  - Content-Length must be digits only (`/^\d+$/`); Number() forms (1e6, 0x10,
 *    +10, 12.5) and a comma-joined multi-header are refused;
 *  - the stream is read chunk by chunk and cancelled as soon as the total passes
 *    the cap (a missing or lying Content-Length cannot get around it).
 * Signatures (e.g. LINE x-line-signature) must be verified over these bytes, not
 * over a decoded string: UTF-8 decoding replaces invalid bytes with U+FFFD.
 */
export type CappedBody = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "read_error" };

export async function readBodyCapped(req: Request, maxBytes: number): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, reason: "read_error" };
    const n = Number(declared);
    if (n > maxBytes) return { ok: false, reason: "too_large" };
  }
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "read_error" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}
