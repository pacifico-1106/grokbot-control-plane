/**
 * D9 (八坂 GO 2026-10-05): shared outbound-webhook helpers for the legacy
 * approval callback and the conversation wake webhook under
 * WEBHOOK_HARDENING_ENABLED — failure categories (the only thing an API
 * response / audit ever shows), Standard Webhooks signing-key resolution and
 * headers, stable webhook-ids (D7 dedupe with MCP Events), and the transport
 * wrapper over #267's postWebhook. Dummy values, fake transport, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

const ob = await import("@/lib/webhooks/outbound");
const { verifyStandardWebhook } = await import("@/lib/mcp-events/standard-webhooks");
type PinnedRequest = import("@/lib/mcp-events/transport").PinnedRequest;

afterEach(() => ob.__setOutboundWebhookTransportForTests(null));

describe("failure categories (fixed set; never raw text)", () => {
  test("postWebhook reasons map to categories", () => {
    const f = (category: string, reason: string, status?: number) =>
      ob.categorizePostFailure({ ok: false, category: category as never, reason, retryable: false, status });
    for (const r of ["url_invalid", "https_required", "userinfo_not_allowed", "fragment_not_allowed", "port_not_allowed", "ip_literal_not_allowed", "hostname_not_allowed"]) {
      expect(f("connection_refused", r)).toBe("invalid_url");
    }
    expect(f("connection_refused", "address_blocked")).toBe("address_blocked");
    expect(f("connection_refused", "dns_failed")).toBe("dns_failed");
    expect(f("connection_refused", "connect_failed")).toBe("connection_failed");
    expect(f("tls_error", "tls_error")).toBe("tls_error");
    expect(f("timeout", "timeout")).toBe("timeout");
    expect(f("http_4xx", "redirect_refused", 302)).toBe("redirect_refused");
    expect(f("http_4xx", "body_too_large")).toBe("body_too_large");
    expect(f("http_4xx", "http_410", 410)).toBe("http_4xx");
    expect(f("http_4xx", "http_4xx", 404)).toBe("http_4xx");
    expect(f("http_5xx", "http_5xx", 503)).toBe("http_5xx");
    expect(f("connection_refused", "something the receiver said")).toBe("connection_failed");
  });
  test("HTTP status → category (2xx → null)", () => {
    expect(ob.categorizeHttpStatus(200)).toBeNull();
    expect(ob.categorizeHttpStatus(204)).toBeNull();
    expect(ob.categorizeHttpStatus(301)).toBe("redirect_refused");
    expect(ob.categorizeHttpStatus(404)).toBe("http_4xx");
    expect(ob.categorizeHttpStatus(500)).toBe("http_5xx");
    expect(ob.categorizeHttpStatus(101)).toBe("http_4xx");
  });
  test("legacy fetch errors → category; the message never survives", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(ob.categorizeFetchError(timeout)).toBe("timeout");
    expect(ob.categorizeFetchError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:80"), { code: "ECONNREFUSED" }) });
    expect(ob.categorizeFetchError(refused)).toBe("connection_failed");
    const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND internal.corp"), { code: "ENOTFOUND" }) });
    expect(ob.categorizeFetchError(dns)).toBe("dns_failed");
    const tls = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
    expect(ob.categorizeFetchError(tls)).toBe("tls_error");
    expect(ob.categorizeFetchError(Object.assign(new TypeError("Failed to parse URL from ftp://x"), { code: "ERR_INVALID_URL" }))).toBe("invalid_url");
    expect(ob.categorizeFetchError("weird")).toBe("connection_failed");
    expect(ob.WEBHOOK_FAILURE_CATEGORIES).toEqual([
      "invalid_url", "address_blocked", "dns_failed", "connection_failed", "tls_error", "timeout",
      "redirect_refused", "http_4xx", "http_5xx", "body_too_large", "config_unavailable",
    ]);
  });
});

describe("Standard Webhooks signing", () => {
  test("whsec_ secret → its decoded key; other non-empty secret → its UTF-8 bytes; empty → null", () => {
    const raw = randomBytes(32);
    expect(ob.signingKeyFromSecret(`whsec_${raw.toString("base64")}`)!.equals(raw)).toBe(true);
    expect(ob.signingKeyFromSecret("sender-key-handoff")!.equals(Buffer.from("sender-key-handoff", "utf8"))).toBe(true);
    expect(ob.signingKeyFromSecret("  ")).toBeNull();
    expect(ob.signingKeyFromSecret(null)).toBeNull();
    expect(ob.signingKeyFromSecret(undefined)).toBeNull();
    // whsec_ that does not parse is used as an opaque string (never silently unsigned)
    expect(ob.signingKeyFromSecret("whsec_short")!.equals(Buffer.from("whsec_short"))).toBe(true);
  });
  test("receiver secret string for a reused opaque wake secret = whsec_ + base64(utf8)", () => {
    expect(ob.receiverWhsecFor("sender-key-handoff")).toBe(`whsec_${Buffer.from("sender-key-handoff").toString("base64")}`);
    const w = `whsec_${randomBytes(32).toString("base64")}`;
    expect(ob.receiverWhsecFor(w)).toBe(w);
  });
  test("headers: id + timestamp always, signature only with a key; verifies with the receiver's whsec", () => {
    const body = JSON.stringify({ a: 1 });
    const unsigned = ob.standardWebhookHeaders(null, "msg_x", 1_790_000_000, body);
    expect(unsigned).toEqual({ "webhook-id": "msg_x", "webhook-timestamp": "1790000000" });
    const key = ob.signingKeyFromSecret("sender-key-handoff")!;
    const signed = ob.standardWebhookHeaders(key, "msg_x", 1_790_000_000, body);
    expect(signed["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(verifyStandardWebhook(key, { id: "msg_x", timestamp: signed["webhook-timestamp"], signature: signed["webhook-signature"] }, body, { nowSec: 1_790_000_010 })).toBe(true);
    expect(verifyStandardWebhook(key, { id: "msg_x", timestamp: signed["webhook-timestamp"], signature: signed["webhook-signature"] }, body + " ", { nowSec: 1_790_000_010 })).toBe(false);
  });
  test("stable webhook ids: same parts → same id, any part differs → different id, no raw input inside", () => {
    const a = ob.stableWebhookId("cb", ["apr_1", "approved", "2026-10-05T00:00:00.000Z"]);
    expect(a).toMatch(/^msg_cb_[0-9a-f]{32}$/);
    expect(ob.stableWebhookId("cb", ["apr_1", "approved", "2026-10-05T00:00:00.000Z"])).toBe(a);
    expect(ob.stableWebhookId("cb", ["apr_1", "rejected", "2026-10-05T00:00:00.000Z"])).not.toBe(a);
    expect(ob.stableWebhookId("cb", ["apr_1a", "pproved", "2026-10-05T00:00:00.000Z"])).not.toBe(a);
    expect(a).not.toContain("apr_1");
  });
});

describe("postHardenedWebhook (over #267 postWebhook)", () => {
  const seen: PinnedRequest[] = [];
  const fake = (answers: Array<{ address: string; family: 4 | 6 }>, status = 200, respBody = "receiver internals: stack trace") => ({
    lookup: async () => answers,
    request: async (r: PinnedRequest) => { seen.push(r); return { status, body: Buffer.from(respBody) }; },
  });
  test("pins the checked public address, sends our UA, returns ok without the receiver body", async () => {
    seen.length = 0;
    ob.__setOutboundWebhookTransportForTests(fake([{ address: "93.184.216.34", family: 4 }]));
    const r = await ob.postHardenedWebhook("https://hooks.example.com/cb?x=1", "{}", { "content-type": "application/json" }, { timeoutMs: 4000, userAgent: "Staffpass-ApprovalHook/1.0" });
    expect(r).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ address: "93.184.216.34", hostname: "hooks.example.com", path: "/cb?x=1", timeoutMs: 4000, userAgent: "Staffpass-ApprovalHook/1.0" });
  });
  test("any private answer → address_blocked, nothing sent; 302 → redirect_refused (one request, not followed); 500 → http_5xx", async () => {
    seen.length = 0;
    ob.__setOutboundWebhookTransportForTests(fake([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]));
    expect(await ob.postHardenedWebhook("https://hooks.example.com/cb", "{}", {}, { timeoutMs: 4000 })).toEqual({ ok: false, category: "address_blocked" });
    expect(seen).toHaveLength(0);
    ob.__setOutboundWebhookTransportForTests(fake([{ address: "169.254.169.254", family: 4 }]));
    expect(await ob.postHardenedWebhook("https://hooks.example.com/cb", "{}", {}, { timeoutMs: 4000 })).toEqual({ ok: false, category: "address_blocked" });
    ob.__setOutboundWebhookTransportForTests(fake([{ address: "93.184.216.34", family: 4 }], 302));
    expect(await ob.postHardenedWebhook("https://hooks.example.com/cb", "{}", {}, { timeoutMs: 4000 })).toEqual({ ok: false, category: "redirect_refused" });
    expect(seen).toHaveLength(1);
    ob.__setOutboundWebhookTransportForTests(fake([{ address: "93.184.216.34", family: 4 }], 500));
    const r = await ob.postHardenedWebhook("https://hooks.example.com/cb", "{}", {}, { timeoutMs: 4000 });
    expect(r).toEqual({ ok: false, category: "http_5xx" });
    expect(JSON.stringify(r)).not.toContain("receiver internals");
  });
  test("http://, IP literal, non-443 port → invalid_url without DNS or request", async () => {
    seen.length = 0;
    let lookups = 0;
    ob.__setOutboundWebhookTransportForTests({ lookup: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; }, request: async (r) => { seen.push(r); return { status: 200, body: Buffer.alloc(0) }; } });
    for (const u of ["http://hooks.example.com/cb", "https://10.0.0.1/cb", "https://hooks.example.com:8443/cb", "https://localhost/cb", "not a url"]) {
      expect(await ob.postHardenedWebhook(u, "{}", {}, { timeoutMs: 4000 })).toEqual({ ok: false, category: "invalid_url" });
    }
    expect(lookups).toBe(0);
    expect(seen).toHaveLength(0);
  });
});
