/**
 * CIMD fetch SSRF / DNS-rebinding hardening (reland-8). No network: the DNS
 * resolver and the node:https request are injected through `deps.transport`
 * (tests/security/no-network.ts forbids the real ones). The one real socket
 * below is a loopback TCP server that proves net.connect uses the pinned
 * lookup instead of DNS.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { __setOAuthStoreForTests, createMemoryOAuthStore } from "@/lib/data/oauth";
import { CIMD_MAX_BYTES, resolveCimdClient, type CimdTransport } from "../cimd";
import { isPrivateAddress, pinnedLookup } from "../net-guard";

const URL_OK = "https://claude.ai/oauth/mcp-client.json";
const PUBLIC = { address: "160.79.104.10", family: 4 as const };
const docBody = JSON.stringify({
  client_id: URL_OK,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
});

type Reply =
  | { status?: number; headers?: Record<string, string>; chunks?: Array<string | Buffer>; dripMs?: number }
  | "hang";
type Seen = { opts: RequestOptions; destroyed: boolean };

/** Fake DNS (answers per call) + fake node:https request. */
function fakeTransport(answers: Array<Array<{ address: string; family: 4 | 6 }>> | "hang", reply: Reply = {}) {
  let lookups = 0;
  const seen: Seen[] = [];
  const transport: CimdTransport = {
    lookup: (host) => {
      lookups++;
      expect(host).toBe("claude.ai");
      if (answers === "hang") return new Promise(() => undefined);
      return Promise.resolve(answers[Math.min(lookups - 1, answers.length - 1)]);
    },
    request: ((opts: RequestOptions, cb: (res: IncomingMessage) => void) => {
      const entry: Seen = { opts, destroyed: false };
      seen.push(entry);
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; setTimeout: () => void };
      req.setTimeout = () => undefined;
      req.destroy = () => { entry.destroyed = true; };
      req.end = () => {
        if (reply === "hang") return;
        const res = new PassThrough() as unknown as PassThrough & { statusCode: number; headers: Record<string, string> };
        res.statusCode = reply.status ?? 200;
        res.headers = { "content-type": "application/json", ...(reply.headers ?? {}) };
        const origDestroy = res.destroy.bind(res);
        res.destroy = ((e?: Error) => { entry.destroyed = true; return origDestroy(e); }) as typeof res.destroy;
        queueMicrotask(() => {
          cb(res as unknown as IncomingMessage);
          const chunks = reply.chunks ?? [docBody];
          if (reply.dripMs) {
            let i = 0;
            const tick = () => { if (entry.destroyed) return; res.write(chunks[i++ % chunks.length]); setTimeout(tick, reply.dripMs); };
            tick();
          } else {
            for (const c of chunks) res.write(c);
            res.end();
          }
        });
      };
      return req as unknown as ClientRequest;
    }) as CimdTransport["request"],
  };
  return { transport, seen, lookups: () => lookups };
}

beforeEach(() => {
  __setOAuthStoreForTests(createMemoryOAuthStore());
  delete process.env.MCP_OAUTH_CIMD_ALLOWED_HOSTS;
});
afterEach(() => {
  __setOAuthStoreForTests(null);
  delete process.env.MCP_OAUTH_CIMD_ALLOWED_HOSTS;
});

describe("connection is pinned to the single checked DNS answer", () => {
  test("public document → fetched over https:443 to the resolved IP, SNI/Host = hostname, one lookup", async () => {
    const f = fakeTransport([[PUBLIC]]);
    const r = await resolveCimdClient(URL_OK, { transport: f.transport });
    expect(r.ok).toBe(true);
    expect(f.lookups()).toBe(1);
    expect(f.seen).toHaveLength(1);
    const o = f.seen[0].opts as RequestOptions & { servername?: string; rejectUnauthorized?: boolean };
    expect(o.hostname).toBe(PUBLIC.address);
    expect(o.family).toBe(4);
    expect(o.port).toBe(443);
    expect(o.protocol).toBe("https:");
    expect(o.method).toBe("GET");
    expect(o.path).toBe("/oauth/mcp-client.json");
    expect(o.servername).toBe("claude.ai");
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.agent).toBe(false);
    expect((o.headers as Record<string, string>).host).toBe("claude.ai");
    expect((o.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
  });

  test("rebinding: lookup #1 public, lookup #2 private → connects only to the pinned public IP; any re-lookup on the socket yields the pinned IP", async () => {
    const f = fakeTransport([[PUBLIC], [{ address: "169.254.169.254", family: 4 }]]);
    const r = await resolveCimdClient(URL_OK, { transport: f.transport });
    expect(r.ok).toBe(true);
    expect(f.lookups()).toBe(1); // resolved exactly once per fetch
    const o = f.seen[0].opts;
    expect(o.hostname).toBe(PUBLIC.address);
    // Even if net/tls asked again (they don't for an IP literal), the lookup is pinned.
    const lookup = o.lookup as unknown as (h: string, opts: object, cb: (...a: unknown[]) => void) => void;
    expect(typeof lookup).toBe("function");
    const single = await new Promise<unknown[]>((ok) => lookup("claude.ai", {}, (...a) => ok(a)));
    expect(single).toEqual([null, PUBLIC.address, 4]);
    const all = await new Promise<unknown[]>((ok) => lookup("claude.ai", { all: true }, (...a) => ok(a)));
    expect(all).toEqual([null, [PUBLIC]]);
    // The next (uncached) fetch sees the private answer and is refused before any connection.
    __setOAuthStoreForTests(createMemoryOAuthStore());
    const again = await resolveCimdClient(URL_OK, { transport: f.transport });
    expect(again).toEqual({ ok: false, error: "private_address" });
    expect(f.lookups()).toBe(2);
    expect(f.seen).toHaveLength(1);
  });

  test("pinnedLookup really drives net.connect: a hostname connects to the pinned IP without DNS", async () => {
    const server = createServer((s) => s.end("pinned"));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as AddressInfo;
    try {
      const got = await new Promise<string>((ok, fail) => {
        const sock = connect({ host: "rebind.attacker.example", port, lookup: pinnedLookup({ address: "127.0.0.1", family: 4 }) });
        let buf = "";
        sock.on("data", (d) => (buf += d));
        sock.on("end", () => ok(buf));
        sock.on("error", fail);
      });
      expect(got).toBe("pinned");
    } finally {
      server.close();
    }
  });
});

describe("non-public answers refused before connecting", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "0.0.0.0", "100.64.0.1", "100.100.100.200",
    "169.254.169.254", "169.254.170.2", "192.0.0.192", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "0::1", "0:0:0:0:0:0:0:1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd00::1",
    "fd00:ec2::254", "fd20:ce::254", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:10.0.0.1",
    "::127.0.0.1", "::ffff:0:10.0.0.1", "64:ff9b::169.254.169.254", "64:ff9b::a00:1", "64:ff9b:1::a00:1",
    "2002:7f00:1::1", "2002:a9fe:a9fe::1", "2001:0:4136:e378::1", "2001:db8::1",
  ];
  for (const ip of blocked) test(`hostname resolving to ${ip} → private_address, no request`, async () => {
    const f = fakeTransport([[{ address: ip, family: ip.includes(":") ? 6 : 4 }]]);
    const r = await resolveCimdClient(URL_OK, { transport: f.transport });
    expect(r).toEqual({ ok: false, error: "private_address" });
    expect(f.seen).toHaveLength(0);
  });
  test("one private answer among public ones → refused", async () => {
    const f = fakeTransport([[PUBLIC, { address: "2606:4700::1111", family: 6 }, { address: "fd00:ec2::254", family: 6 }]]);
    expect(await resolveCimdClient(URL_OK, { transport: f.transport })).toEqual({ ok: false, error: "private_address" });
    expect(f.seen).toHaveLength(0);
  });
  test("no answers → refused", async () => {
    const f = fakeTransport([[]]);
    expect((await resolveCimdClient(URL_OK, { transport: f.transport })).ok).toBe(false);
    expect(f.seen).toHaveLength(0);
  });
  test("classifier: IPv6 / mapped / NAT64 / 6to4 / Teredo forms", () => {
    for (const ip of blocked) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    for (const ip of ["8.8.8.8", "160.79.104.10", "2606:4700::1111", "2600:1f18::1"]) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    for (const junk of ["", "claude.ai", "127.1", "0x7f.0.0.1", "[::1]"]) expect([junk, isPrivateAddress(junk)]).toEqual([junk, true]);
  });
});

describe("URL shape: https only, no port, no IP literal (even if allowlisted)", () => {
  test("refused without DNS or connection", async () => {
    process.env.MCP_OAUTH_CIMD_ALLOWED_HOSTS = "claude.ai,127.0.0.1,[::1],169.254.169.254";
    for (const id of [
      "http://claude.ai/oauth/mcp-client.json", "https://claude.ai:8443/oauth/mcp-client.json",
      "https://127.0.0.1/c.json", "https://[::1]/c.json", "https://169.254.169.254/latest/meta-data",
    ]) {
      const f = fakeTransport([[PUBLIC]]);
      const r = await resolveCimdClient(id, { transport: f.transport });
      expect([id, r.ok]).toEqual([id, false]);
      expect([id, f.lookups(), f.seen.length]).toEqual([id, 0, 0]);
    }
  });
});

describe("redirects are never followed", () => {
  for (const status of [301, 302, 303, 307, 308]) test(`${status} → redirect_refused, single request`, async () => {
    const f = fakeTransport([[PUBLIC]], { status, headers: { location: "https://169.254.169.254/latest/meta-data" }, chunks: [""] });
    expect(await resolveCimdClient(URL_OK, { transport: f.transport })).toEqual({ ok: false, error: "redirect_refused" });
    expect(f.seen).toHaveLength(1);
    expect(f.lookups()).toBe(1);
  });
});

describe("size cap", () => {
  test("declared content-length over the cap → too_large", async () => {
    const f = fakeTransport([[PUBLIC]], { headers: { "content-length": String(CIMD_MAX_BYTES + 1) }, chunks: ["{}"] });
    expect(await resolveCimdClient(URL_OK, { transport: f.transport })).toEqual({ ok: false, error: "too_large" });
  });
  test("streamed body over the cap (no content-length) → too_large, connection destroyed", async () => {
    const f = fakeTransport([[PUBLIC]], { chunks: [Buffer.alloc(40 * 1024, 0x20), Buffer.alloc(40 * 1024, 0x20)] });
    expect(await resolveCimdClient(URL_OK, { transport: f.transport })).toEqual({ ok: false, error: "too_large" });
    expect(f.seen[0].destroyed).toBe(true);
  });
  test("compressed response (we asked for identity) → refused", async () => {
    const f = fakeTransport([[PUBLIC]], { headers: { "content-encoding": "gzip" } });
    expect((await resolveCimdClient(URL_OK, { transport: f.transport })).ok).toBe(false);
  });
});

describe("overall deadline", () => {
  test("server never answers → fetch_failed at the deadline, request destroyed", async () => {
    const f = fakeTransport([[PUBLIC]], "hang");
    const t0 = Date.now();
    expect(await resolveCimdClient(URL_OK, { transport: f.transport, timeoutMs: 80 })).toEqual({ ok: false, error: "fetch_failed" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.seen[0].destroyed).toBe(true);
  });
  test("slow-drip body that never ends → fetch_failed at the deadline (not an idle timer)", async () => {
    const f = fakeTransport([[PUBLIC]], { chunks: [" "], dripMs: 10 });
    const t0 = Date.now();
    expect(await resolveCimdClient(URL_OK, { transport: f.transport, timeoutMs: 120 })).toEqual({ ok: false, error: "fetch_failed" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.seen[0].destroyed).toBe(true);
  });
  test("DNS that never answers → fetch_failed at the deadline, no request", async () => {
    const f = fakeTransport("hang");
    const t0 = Date.now();
    expect(await resolveCimdClient(URL_OK, { transport: f.transport, timeoutMs: 80 })).toEqual({ ok: false, error: "fetch_failed" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.seen).toHaveLength(0);
  });
});
