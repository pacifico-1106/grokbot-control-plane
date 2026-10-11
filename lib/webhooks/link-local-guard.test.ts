/**
 * Link-local / cloud-metadata block for the two legacy outbound webhooks
 * (Kimura 2026-10-05 08:57): no flag, applies with WEBHOOK_HARDENING_ENABLED
 * OFF. Decided on the address the connection actually uses (custom DNS
 * lookup on the undici connector), every redirect hop, IP literals too.
 * Everything else (other private ranges, http, non-443 ports) stays allowed.
 *
 * Part 1: the single constant blocklist + address classifier.
 * Part 2: the connect-time lookup / connector (injected resolver, no network).
 * Part 3: real Node fetch + the guard dispatcher against a local 127.0.0.1
 *         server (spawned `node`, so undici's real connector / redirect logic
 *         is exercised; Bun's fetch ignores `dispatcher`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const g = await import("@/lib/webhooks/link-local-guard");
const { categorizeFetchError } = await import("@/lib/webhooks/outbound");

type Answer = { address: string; family: number };
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | Answer[], family?: number) => void;
function lookupP(host: string, options: Record<string, unknown> = {}) {
  return new Promise<{ err: NodeJS.ErrnoException | null; address?: string | Answer[]; family?: number }>((done) => {
    g.guardedLookup(host, options, ((err, address, family) => done({ err, address, family })) as LookupCb);
  });
}
let resolverCalls: Array<{ host: string; options: Record<string, unknown> }> = [];
function useResolver(map: Record<string, Answer[] | NodeJS.ErrnoException>) {
  resolverCalls = [];
  g.__setLinkLocalGuardResolverForTests((host, options, cb) => {
    resolverCalls.push({ host, options: { ...options } });
    const a = map[host];
    if (!a) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
    if (!Array.isArray(a)) return cb(a, []);
    cb(null, a);
  });
}
afterEach(() => g.__setLinkLocalGuardResolverForTests(null));

describe("blocklist: one constant list, documented entries only", () => {
  test("exact entries (CIDR) in one exported constant", () => {
    expect(g.LINK_LOCAL_METADATA_BLOCKLIST.map((e) => e.cidr)).toEqual([
      "169.254.0.0/16",
      "100.100.100.200/32",
      "192.0.0.192/32",
      "fe80::/10",
      "fd00:ec2::254/128",
      "fd00:ec2::23/128",
      "fd20:ce::254/128",
    ]);
    for (const e of g.LINK_LOCAL_METADATA_BLOCKLIST) expect(e.note.length).toBeGreaterThan(5);
  });
  test("IPv4 link-local + metadata are blocked", () => {
    for (const ip of ["169.254.169.254", "169.254.170.2", "169.254.170.23", "169.254.0.23", "169.254.0.0", "169.254.255.255", "100.100.100.200", "192.0.0.192"]) {
      expect([ip, g.isLinkLocalOrMetadataAddress(ip)]).toEqual([ip, true]);
    }
  });
  test("IPv6 link-local + metadata are blocked (any spelling, zone id, brackets)", () => {
    for (const ip of ["fe80::1", "fe80::1%eth0", "FE80::A", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80:0:0:0:0:0:0:1",
      "fd00:ec2::254", "fd00:0ec2:0000:0000:0000:0000:0000:0254", "FD00:EC2::254", "fd00:ec2::23", "fd20:ce::254", "[fd00:ec2::254]", "[fe80::1]"]) {
      expect([ip, g.isLinkLocalOrMetadataAddress(ip)]).toEqual([ip, true]);
    }
  });
  test("IPv4-mapped / -compatible / -translated / NAT64 forms of every IPv4 entry are blocked", () => {
    for (const ip of ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::FFFF:A9FE:A9FE", "0:0:0:0:0:ffff:169.254.169.254", "[::ffff:a9fe:a9fe]",
      "::169.254.169.254", "::a9fe:a9fe", "::ffff:0:169.254.169.254", "::ffff:0:a9fe:a9fe",
      "64:ff9b::169.254.169.254", "64:ff9b::a9fe:a9fe", "::ffff:169.254.170.2", "::ffff:100.100.100.200", "64:ff9b::6464:64c8", "::ffff:192.0.0.192", "::ffff:c000:c0"]) {
      expect([ip, g.isLinkLocalOrMetadataAddress(ip)]).toEqual([ip, true]);
    }
  });
  test("everything else is NOT blocked by this guard (private, loopback, CGNAT, public, neighbours)", () => {
    for (const ip of ["93.184.216.34", "10.0.0.5", "172.16.0.1", "192.168.1.1", "127.0.0.1", "100.64.0.1", "100.100.100.201", "192.0.0.193",
      "169.253.255.255", "169.255.0.0", "168.63.129.16", "::1", "::", "fec0::1", "fe7f:ffff::1", "fc00::1", "fd00:ec2::253", "fd00:ec2::1:254", "fd20:ce::253",
      "2606:4700::1111", "::ffff:10.0.0.5", "::ffff:93.184.216.34", "64:ff9b::93.184.216.34", "64:ff9b:1::a9fe:a9fe"]) {
      expect([ip, g.isLinkLocalOrMetadataAddress(ip)]).toEqual([ip, false]);
    }
  });
  test("not an IP address → not classified here (hostnames go through the lookup)", () => {
    for (const s of ["metadata.google.internal", "", "1.2.3", "::ffff:999.1.1.1", "169.254.169.254.example.com", "fe80::1::2"]) {
      expect([s, g.isLinkLocalOrMetadataAddress(s)]).toEqual([s, false]);
    }
  });
});

describe("connect-time lookup (the address that is checked is the one connected to)", () => {
  test("hostname resolving to 169.254.169.254 → refused with the guard code → address_blocked", async () => {
    useResolver({ "metadata.example.test": [{ address: "169.254.169.254", family: 4 }] });
    const r = await lookupP("metadata.example.test", {});
    expect(r.err?.code).toBe(g.ADDRESS_BLOCKED_CODE);
    expect(r.address).toBeUndefined();
    expect(categorizeFetchError(new TypeError("fetch failed", { cause: r.err! }))).toBe("address_blocked");
    expect(categorizeFetchError(r.err)).toBe("address_blocked");
  });
  test("any blocked answer refuses the whole name (no 'try the next address')", async () => {
    useResolver({ "mixed.example.test": [{ address: "93.184.216.34", family: 4 }, { address: "169.254.170.2", family: 4 }] });
    expect((await lookupP("mixed.example.test", {})).err?.code).toBe(g.ADDRESS_BLOCKED_CODE);
    expect((await lookupP("mixed.example.test", { all: true })).err?.code).toBe(g.ADDRESS_BLOCKED_CODE);
  });
  test("IPv6 answers: AWS IMDS v6, EKS v6, GCP v6, fe80::, mapped / NAT64 → refused", async () => {
    const names: Record<string, Answer[]> = {
      "imds6.test": [{ address: "fd00:ec2::254", family: 6 }],
      "eks6.test": [{ address: "fd00:ec2::23", family: 6 }],
      "gcp6.test": [{ address: "fd20:ce::254", family: 6 }],
      "ll6.test": [{ address: "fe80::abcd", family: 6 }],
      "mapped.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
      "nat64.test": [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
    };
    useResolver(names);
    for (const host of Object.keys(names)) expect([host, (await lookupP(host, { all: true })).err?.code]).toEqual([host, g.ADDRESS_BLOCKED_CODE]);
  });
  test("private 10.x / public answers pass through unchanged (single and all:true)", async () => {
    useResolver({
      "private.test": [{ address: "10.0.0.5", family: 4 }],
      "public.test": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }],
    });
    expect(await lookupP("private.test", {})).toEqual({ err: null, address: "10.0.0.5", family: 4 });
    expect(await lookupP("public.test", {})).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect(await lookupP("public.test", { all: true })).toEqual({
      err: null, address: [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }], family: undefined,
    });
  });
  test("the resolver is always asked for ALL answers, caller hints (family) preserved", async () => {
    useResolver({ "public.test": [{ address: "93.184.216.34", family: 4 }] });
    await lookupP("public.test", { family: 4, hints: 32 });
    expect(resolverCalls).toEqual([{ host: "public.test", options: { family: 4, hints: 32, all: true } }]);
  });
  test("resolver errors pass through untouched (dns_failed stays dns_failed)", async () => {
    useResolver({});
    const r = await lookupP("nx.test", {});
    expect(r.err?.code).toBe("ENOTFOUND");
    expect(categorizeFetchError(new TypeError("fetch failed", { cause: r.err! }))).toBe("dns_failed");
  });
});

describe("connector: IP literals are checked too (net.connect skips lookup for them)", () => {
  type Opts = { hostname: string; host?: string; port: string; protocol: string };
  function connectP(hostname: string) {
    const baseCalls: Opts[] = [];
    const connect = g.createGuardedConnect(((opts: Opts, cb: (e: Error | null, s: unknown) => void) => { baseCalls.push(opts); cb(null, { fake: true }); }) as never);
    return new Promise<{ err: (Error & { code?: string }) | null; baseCalls: Opts[] }>((done) => {
      (connect as unknown as (o: Opts, cb: (e: Error | null) => void) => void)({ hostname, port: "", protocol: "http:" }, (err) => done({ err: err as never, baseCalls }));
    });
  }
  test("blocked literals never reach the base connector", async () => {
    for (const h of ["169.254.169.254", "169.254.170.2", "100.100.100.200", "[fd00:ec2::254]", "[::ffff:a9fe:a9fe]", "[fe80::1]", "[64:ff9b::a9fe:a9fe]"]) {
      const r = await connectP(h);
      expect([h, r.err?.code, r.baseCalls.length]).toEqual([h, g.ADDRESS_BLOCKED_CODE, 0]);
    }
  });
  test("hostnames and allowed literals go to the base connector (whose lookup is the guarded one)", async () => {
    for (const h of ["callback.example.com", "10.0.0.5", "93.184.216.34", "[2606:4700::1111]", "127.0.0.1"]) {
      const r = await connectP(h);
      expect([h, r.err, r.baseCalls.length]).toEqual([h, null, 1]);
    }
  });
  test("one shared dispatcher; withLinkLocalGuard only adds it (init otherwise untouched)", () => {
    const d = g.linkLocalGuardDispatcher();
    expect(d).toBe(g.linkLocalGuardDispatcher());
    const signal = AbortSignal.timeout(1000);
    const init = { method: "POST", headers: { a: "b" }, body: "x", signal };
    const out = g.withLinkLocalGuard(init) as RequestInit & { dispatcher?: unknown };
    expect(out).toEqual({ ...init, dispatcher: d } as never);
    expect(init).toEqual({ method: "POST", headers: { a: "b" }, body: "x", signal });
  });
});

// bun:test accepts a per-test timeout (3rd arg); the local type shim does not declare it.
const slowTest = test as unknown as (name: string, fn: () => unknown, timeoutMs: number) => void;
describe("real Node fetch through the guard dispatcher (local server, injected resolver)", () => {
  slowTest("hostname→169.254.169.254, redirect hops to metadata (name / v4 literal / mapped v6 literal), IPv6 forms → address_blocked, server never reached; allowed hosts + allowed redirects still work", () => {
    const dir = mkdtempSync(join(tmpdir(), "llguard-"));
    try {
      const bundle = join(dir, "probe.cjs");
      const built = spawnSync(process.execPath, ["build", resolve("tests/fixtures/link-local-guard-node-probe.ts"), "--target=node", "--format=cjs", "--external=undici", `--outfile=${bundle}`], { encoding: "utf8" });
      expect(built.status).toBe(0);
      const ran = spawnSync("node", [bundle], { encoding: "utf8", env: { ...process.env, NODE_PATH: resolve("node_modules") }, timeout: 60_000 });
      if (ran.status !== 0) console.error(ran.stderr);
      expect(ran.status).toBe(0);
      const results = Object.fromEntries(ran.stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => {
        const o = JSON.parse(l) as { name: string; result: string; hits: string[] };
        return [o.name, { result: o.result, hits: o.hits }];
      }));
      expect(results).toEqual({
        "allowed host (resolves to 127.0.0.1)": { result: "200", hits: ["/ok"] },
        "allowed host, redirect to allowed host": { result: "200", hits: ["/redir", "/ok"] },
        "hostname resolving to 169.254.169.254": { result: "address_blocked", hits: [] },
        "hostname with one 169.254.170.2 answer among allowed ones": { result: "address_blocked", hits: [] },
        "redirect to a hostname resolving to 169.254.169.254": { result: "address_blocked", hits: ["/redir"] },
        "redirect to http://169.254.169.254/ literal": { result: "address_blocked", hits: ["/redir"] },
        "redirect to http://[::ffff:169.254.169.254]/ literal": { result: "address_blocked", hits: ["/redir"] },
        "redirect to http://[fd00:ec2::254]/ literal": { result: "address_blocked", hits: ["/redir"] },
        "direct http://169.254.169.254/ literal": { result: "address_blocked", hits: [] },
        "direct http://100.100.100.200/ literal": { result: "address_blocked", hits: [] },
        "direct http://[fe80::1]/ literal": { result: "address_blocked", hits: [] },
        "hostname resolving to fd00:ec2::254": { result: "address_blocked", hits: [] },
        "hostname resolving to ::ffff:169.254.169.254": { result: "address_blocked", hits: [] },
        "hostname resolving to 64:ff9b::a9fe:a9fe": { result: "address_blocked", hits: [] },
        "hostname resolving to fd20:ce::254": { result: "address_blocked", hits: [] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
