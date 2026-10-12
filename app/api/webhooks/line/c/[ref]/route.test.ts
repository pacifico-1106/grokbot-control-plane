/**
 * L-4 hardening (木村 10/12) of the per-employee LINE webhook (#359):
 * - the body is capped at 1 MB WHILE the stream is read (no full buffering), and a
 *   Content-Length over 1 MB is refused up front (nothing read);
 * - x-line-signature is verified over the RAW BYTES LINE signed, not over a UTF-8
 *   decoded string (decoding turns invalid bytes into U+FFFD, so the HMAC was over
 *   different bytes than LINE signed).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCommAccount, resetDemoCommAccounts, setCommAccountSecrets, type CommAccount } from "@/lib/comm/accounts";
import { POST } from "@/app/api/webhooks/line/c/[ref]/route";

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "COMM_CONVERSATION_TOKEN_SECRET"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = "ec000000-0000-4000-8000-0000000000c1";
const EMP = "ec100000-0000-4000-8000-0000000000c1";
const BOT = "U" + "2".repeat(32);
const SECRET = "fedcba9876543210fedcba9876543210";
const MB = 1_000_000;

let account: CommAccount;
beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.COMM_CONVERSATION_TOKEN_SECRET = "t".repeat(48);
  resetDemoCommAccounts();
  const r = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  account = r.account;
  const s = await setCommAccountSecrets({ orgId: ORG, accountId: account.id, secrets: { channelAccessToken: "A".repeat(120), channelSecret: SECRET }, memberId: "m1" });
  if (!s.ok) throw new Error(s.reason);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sigOf = (bytes: Uint8Array | string) => createHmac("sha256", SECRET).update(bytes).digest("base64");
const ctx = () => ({ params: Promise.resolve({ ref: account.webhookRef }) });
const url = () => `http://localhost/api/webhooks/line/c/${account.webhookRef}`;

/** A streamed body (no Content-Length) that counts how many bytes were pulled. */
function streamed(total: number, chunk = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      state.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

describe("1 MB body cap", () => {
  test("Content-Length > 1 MB → 413 up front; the body is never read", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; c.enqueue(new Uint8Array(16)); c.close(); },
    });
    const req = new Request(url(), {
      method: "POST",
      headers: { "content-length": String(MB + 1), "x-line-signature": "x" },
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    const r = await POST(req, ctx());
    expect(r.status).toBe(413);
    expect(pulled).toBe(0);
  });

  test("no Content-Length, streamed body over 1 MB → 413, reading stops at the cap (no full buffering)", async () => {
    const total = 8 * MB;
    const { stream, state } = streamed(total);
    const req = new Request(url(), {
      method: "POST",
      headers: { "x-line-signature": "x" },
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    expect(req.headers.get("content-length")).toBeNull();
    const r = await POST(req, ctx());
    expect(r.status).toBe(413);
    expect(state.pulled).toBeLessThan(MB + 512 * 1024);
  });

  test("exactly 1 MB is not refused for size (signature then decides)", async () => {
    const raw = new Uint8Array(MB).fill(0x20);
    const req = new Request(url(), { method: "POST", headers: { "x-line-signature": "bad" }, body: raw });
    const r = await POST(req, ctx());
    expect(r.status).toBe(401);
  });

  test("a lying small Content-Length with a larger streamed body is still capped", async () => {
    const { stream } = streamed(3 * MB);
    const req = new Request(url(), {
      method: "POST",
      headers: { "content-length": "10", "x-line-signature": "x" },
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    const r = await POST(req, ctx());
    expect([400, 413]).toContain(r.status);
    expect(r.status).not.toBe(200);
  });
});

describe("signature over the raw bytes", () => {
  const payload = (text: Uint8Array) => {
    const head = new TextEncoder().encode(`{"destination":"${BOT}","events":[],"note":"`);
    const tail = new TextEncoder().encode(`"}`);
    const out = new Uint8Array(head.length + text.length + tail.length);
    out.set(head, 0);
    out.set(text, head.length);
    out.set(tail, head.length + text.length);
    return out;
  };

  test("multibyte UTF-8 (日本語・絵文字) signed over the raw bytes → accepted", async () => {
    const raw = payload(new TextEncoder().encode("こんにちは🙂ｱｲｳ"));
    const r = await POST(new Request(url(), { method: "POST", headers: { "x-line-signature": sigOf(raw) }, body: raw }), ctx());
    expect(r.status).toBe(200);
  });

  test("non-UTF-8 bytes signed over the raw bytes → the signature passes (not 401)", async () => {
    const raw = payload(new Uint8Array([0xff, 0xfe, 0x80, 0xc3]));
    const r = await POST(new Request(url(), { method: "POST", headers: { "x-line-signature": sigOf(raw) }, body: raw }), ctx());
    expect(r.status).not.toBe(401);
  });

  test("a signature over the U+FFFD-decoded string (not what was sent) → 401", async () => {
    const raw = payload(new Uint8Array([0xff, 0xfe, 0x80, 0xc3]));
    const decoded = new TextDecoder().decode(raw);
    const r = await POST(new Request(url(), { method: "POST", headers: { "x-line-signature": sigOf(decoded) }, body: raw }), ctx());
    expect(r.status).toBe(401);
  });

  test("a flipped byte → 401", async () => {
    const raw = payload(new TextEncoder().encode("テスト"));
    const signature = sigOf(raw);
    raw[raw.length - 4] ^= 0x01;
    const r = await POST(new Request(url(), { method: "POST", headers: { "x-line-signature": signature }, body: raw }), ctx());
    expect(r.status).toBe(401);
  });
});

describe("flag OFF", () => {
  test("LINE_CONVERSATION_ENABLED off → 404 without reading the body", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const { stream, state } = streamed(2 * MB);
    const req = new Request(url(), {
      method: "POST",
      body: stream,
      // @ts-expect-error -- undici/Bun streaming request bodies
      duplex: "half",
    });
    const r = await POST(req, ctx());
    expect(r.status).toBe(404);
    expect(state.pulled).toBe(0);
  });
});
