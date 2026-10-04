/**
 * SSRF-safe webhook POST for MCP Events deliveries and verification:
 * https:443 only, DNS resolved on EVERY attempt, every answer must be public,
 * the checked IP is pinned for the connection (SNI / Host = hostname), no
 * redirects, bounded body. Fake DNS / transport only (no network).
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildPinnedRequestOptions,
  createNodeWebhookTransport,
  postWebhook,
  validateCallbackUrl,
  type WebhookTransport,
  type PinnedRequest,
} from "@/lib/mcp-events/transport";

function fakeTransport(answers: Array<Array<{ address: string; family: 4 | 6 }>> | Error, status = 200, body = "") {
  const seen: PinnedRequest[] = [];
  let lookups = 0;
  const t: WebhookTransport = {
    lookup: async () => {
      if (answers instanceof Error) throw answers;
      return answers[Math.min(lookups++, answers.length - 1)];
    },
    request: async (req) => { seen.push(req); return { status, body: Buffer.from(body) }; },
  };
  return { t, seen, lookups: () => lookups };
}
const PUBLIC4 = [{ address: "93.184.216.34", family: 4 as const }];

describe("callback URL syntax", () => {
  test("accepts plain https URLs on 443", () => {
    expect(validateCallbackUrl("https://hooks.example.com/mcp/events?x=1")).toEqual({ ok: true, host: "hooks.example.com" });
    expect(validateCallbackUrl("https://hooks.example.com:443/a").ok).toBe(true);
  });
  test("rejects non-https, other ports, userinfo, fragments, IP literals, overlong, garbage", () => {
    for (const bad of [
      "http://hooks.example.com/a", "https://hooks.example.com:8443/a", "https://u:p@hooks.example.com/a",
      "https://hooks.example.com/a#frag", "https://127.0.0.1/a", "https://93.184.216.34/a", "https://[::1]/a",
      "https://[2606:2800:220:1::1]/a", `https://hooks.example.com/${"a".repeat(2050)}`, "not a url", "", "ftp://x.example.com/",
      "https://localhost/a", "https://metadata.google.internal/a",
    ]) {
      expect(validateCallbackUrl(bad).ok).toBe(false);
    }
  });
});

describe("DNS check on every attempt (rebinding), private / metadata answers refused", () => {
  const blocked: Array<[string, string, 4 | 6]> = [
    ["loopback", "127.0.0.1", 4], ["rfc1918", "10.1.2.3", 4], ["rfc1918-172", "172.16.0.5", 4], ["rfc1918-192", "192.168.1.1", 4],
    ["link-local / IMDS", "169.254.169.254", 4], ["CGNAT / Alibaba IMDS", "100.100.100.200", 4], ["unspecified", "0.0.0.0", 4],
    ["v6 loopback", "::1", 6], ["v6 ULA / AWS IMDS v6", "fd00:ec2::254", 6], ["v6 link-local", "fe80::1", 6],
    ["v4-mapped loopback", "::ffff:127.0.0.1", 6],
  ];
  for (const [label, address, family] of blocked) {
    test(`${label} ${address} is refused before connecting`, async () => {
      const { t, seen } = fakeTransport([[...PUBLIC4, { address, family }]]);
      const r = await postWebhook("https://hooks.example.com/a", "{}", {}, t);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("address_blocked");
      expect(r.category).toBe("connection_refused");
      // 3b: a non-public answer is a permanent failure (never retried)
      expect(r.retryable).toBe(false);
      expect(seen).toHaveLength(0);
    });
  }
  test("public at check #1, private at check #2 → second attempt refused", async () => {
    const { t, seen, lookups } = fakeTransport([PUBLIC4, [{ address: "10.0.0.7", family: 4 }]]);
    expect((await postWebhook("https://hooks.example.com/a", "{}", {}, t)).ok).toBe(true);
    const second = await postWebhook("https://hooks.example.com/a", "{}", {}, t);
    expect(second.ok).toBe(false);
    expect(lookups()).toBe(2);
    expect(seen).toHaveLength(1);
  });
  test("no answers / DNS failure → connection_refused, no request", async () => {
    for (const answers of [[[]], new Error("ENOTFOUND")] as const) {
      const { t, seen } = fakeTransport(answers as never);
      const r = await postWebhook("https://hooks.example.com/a", "{}", {}, t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.category).toBe("connection_refused");
      expect(seen).toHaveLength(0);
    }
  });
  test("the checked IP is pinned; hostname goes to SNI + Host", async () => {
    const { t, seen } = fakeTransport([[{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }, ...PUBLIC4]]);
    await postWebhook("https://hooks.example.com/p/q?r=1", '{"a":1}', { "webhook-id": "evt_1" }, t);
    expect(seen[0]).toMatchObject({ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6, hostname: "hooks.example.com", path: "/p/q?r=1" });
    expect(seen[0].headers["webhook-id"]).toBe("evt_1");
    const opts = buildPinnedRequestOptions(seen[0]);
    expect(opts).toMatchObject({
      protocol: "https:", hostname: "2606:2800:220:1:248:1893:25c8:1946", family: 6, port: 443, servername: "hooks.example.com",
      method: "POST", agent: false, rejectUnauthorized: true, path: "/p/q?r=1",
    });
    expect((opts.headers as Record<string, string>).host).toBe("hooks.example.com");
    expect((opts.headers as Record<string, string>)["content-length"]).toBe("7");
  });
});

describe("responses", () => {
  test("3xx is never followed (one request, non-retryable)", async () => {
    const { t, seen } = fakeTransport([PUBLIC4], 302);
    const r = await postWebhook("https://hooks.example.com/a", "{}", {}, t);
    expect(seen).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, reason: "redirect_refused", retryable: false });
  });
  test("410 / 413 are not retried; 5xx / 4xx are", async () => {
    const cases: Array<[number, string, boolean]> = [[410, "http_4xx", false], [413, "http_4xx", false], [500, "http_5xx", true], [503, "http_5xx", true], [404, "http_4xx", true], [429, "http_4xx", true]];
    for (const [status, category, retryable] of cases) {
      const { t } = fakeTransport([PUBLIC4], status);
      expect(await postWebhook("https://hooks.example.com/a", "{}", {}, t)).toMatchObject({ ok: false, status, category, retryable });
    }
  });
  test("2xx ok with the (bounded) response body", async () => {
    const { t } = fakeTransport([PUBLIC4], 204, "");
    expect(await postWebhook("https://hooks.example.com/a", "{}", {}, t)).toMatchObject({ ok: true, status: 204 });
  });
  test("transport errors map to fixed categories (no raw text)", async () => {
    const mk = (code: string): WebhookTransport => ({ lookup: async () => PUBLIC4, request: async () => { throw Object.assign(new Error(`boom ${code} secret-ish detail`), { code }); } });
    expect(await postWebhook("https://hooks.example.com/a", "{}", {}, mk("ETIMEDOUT"))).toMatchObject({ ok: false, category: "timeout", retryable: true });
    expect(await postWebhook("https://hooks.example.com/a", "{}", {}, mk("CERT_HAS_EXPIRED"))).toMatchObject({ ok: false, category: "tls_error" });
    expect(await postWebhook("https://hooks.example.com/a", "{}", {}, mk("ERR_TLS_CERT_ALTNAME_INVALID"))).toMatchObject({ ok: false, category: "tls_error" });
    const refused = await postWebhook("https://hooks.example.com/a", "{}", {}, mk("ECONNREFUSED"));
    expect(refused).toMatchObject({ ok: false, category: "connection_refused" });
    expect(JSON.stringify(refused)).not.toContain("secret-ish");
  });
  test("bodies over 256 KiB are refused before any DNS / request", async () => {
    const { t, seen, lookups } = fakeTransport([PUBLIC4]);
    const r = await postWebhook("https://hooks.example.com/a", "x".repeat(256 * 1024 + 1), {}, t);
    expect(r).toMatchObject({ ok: false, reason: "body_too_large", retryable: false });
    expect(lookups()).toBe(0);
    expect(seen).toHaveLength(0);
  });
  test("an invalid URL never reaches DNS", async () => {
    const { t, lookups } = fakeTransport([PUBLIC4]);
    expect((await postWebhook("http://hooks.example.com/a", "{}", {}, t)).ok).toBe(false);
    expect(lookups()).toBe(0);
  });
});

describe("3a. overall timeout destroys the request and the socket", () => {
  class FakeRes extends EventEmitter { statusCode = 200; destroyed = false; destroy() { this.destroyed = true; return this; } }
  class FakeReq extends EventEmitter {
    destroyed = false; destroyError: unknown = null; idleTimeoutMs = 0;
    setTimeout(ms: number) { this.idleTimeoutMs = ms; return this; }
    destroy(e?: unknown) { if (this.destroyed) return this; this.destroyed = true; this.destroyError = e; queueMicrotask(() => this.emit("error", e ?? new Error("destroyed"))); return this; }
    end() { return this; }
  }
  const pinned = (timeoutMs: number): PinnedRequest => ({
    address: "93.184.216.34", family: 4, hostname: "hooks.example.com", path: "/a", headers: {}, body: Buffer.from("{}"), timeoutMs, maxResponseBytes: 1024,
  });
  test("no response at all → request destroyed at the overall deadline (ETIMEDOUT)", async () => {
    let req: FakeReq | null = null;
    const t = createNodeWebhookTransport({ request: (() => { req = new FakeReq(); return req; }) as never });
    const started = Date.now();
    const err = await t.request(pinned(60)).then(() => null, (e: unknown) => e);
    expect((err as { code?: string })?.code).toBe("ETIMEDOUT");
    expect(req!.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  test("a response that keeps trickling (idle timer never fires) is cut at the overall deadline: response + request destroyed", async () => {
    let req: FakeReq | null = null;
    const res = new FakeRes();
    const t = createNodeWebhookTransport({
      request: ((_opts: unknown, cb: (r: FakeRes) => void) => {
        req = new FakeReq();
        setTimeout(() => {
          cb(res);
          const timer = setInterval(() => { if (res.destroyed) clearInterval(timer); else res.emit("data", Buffer.from("x")); }, 5);
        }, 1);
        return req;
      }) as never,
    });
    const err = await t.request(pinned(80)).then(() => null, (e: unknown) => e);
    expect((err as { code?: string })?.code).toBe("ETIMEDOUT");
    expect(res.destroyed).toBe(true);
    expect(req!.destroyed).toBe(true);
  });
  test("postWebhook aborts the transport's signal when its own deadline passes", async () => {
    let signal: AbortSignal | undefined;
    const t: WebhookTransport = {
      lookup: async () => PUBLIC4,
      request: (req) => { signal = req.signal; return new Promise(() => undefined); },
    };
    const r = await postWebhook("https://hooks.example.com/a", "{}", {}, t, { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, category: "timeout", retryable: true });
    expect(signal?.aborted).toBe(true);
  });
  test("an aborted signal destroys the in-flight node request", async () => {
    let req: FakeReq | null = null;
    const t = createNodeWebhookTransport({ request: (() => { req = new FakeReq(); return req; }) as never });
    const ac = new AbortController();
    const p = t.request({ ...pinned(10_000), signal: ac.signal }).then(() => null, (e: unknown) => e);
    ac.abort();
    const err = await p;
    expect(err).toBeTruthy();
    expect(req!.destroyed).toBe(true);
  });
});

describe("D9: user-agent option (callback / wake keep their own UA)", () => {
  const base = { address: "93.184.216.34", family: 4 as const, hostname: "hooks.example.com", path: "/x", body: Buffer.from("{}"), timeoutMs: 1000, maxResponseBytes: 10 };
  test("default stays Staffpass-MCP-Events/1.0; userAgent overrides; caller headers cannot override UA or Host", async () => {
    const { buildPinnedRequestOptions: build } = await import("@/lib/mcp-events/transport");
    expect((build({ ...base, headers: {} }).headers as Record<string, string>)["user-agent"]).toBe("Staffpass-MCP-Events/1.0");
    const o = build({ ...base, headers: { "user-agent": "evil", host: "internal" }, userAgent: "Staffpass-ApprovalHook/1.0" });
    expect((o.headers as Record<string, string>)["user-agent"]).toBe("Staffpass-ApprovalHook/1.0");
    expect((o.headers as Record<string, string>).host).toBe("hooks.example.com");
  });
});
