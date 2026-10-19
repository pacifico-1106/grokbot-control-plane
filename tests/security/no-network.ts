import { afterAll, expect, mock } from "bun:test";
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as undici from "undici";
import * as http2 from "node:http2";
import * as dgram from "node:dgram";
import * as childProcess from "node:child_process";

// Preloaded for EVERY `bun test` in this repo (bunfig.toml) and by scripts/test-local.mjs.
// 木村 10/12: a direct `bun test <file>` inherited the box env (a real
// LP_HANDOFF_NOTIFY_SLACK_WEBHOOK) and posted real messages to the ops Slack channel.
// So, before any test module loads:
//
// 1. Delete every outbound-notify and outbound-credential env var (exact list from a
//    grep of process.env reads + a pattern for new ones), so no code path even has a
//    destination or a key. Tests that need one set a FAKE value themselves.
export const SCRUBBED_ENV_EXACT = [
  // notify destinations
  "LP_HANDOFF_NOTIFY_SLACK_WEBHOOK", "LP_HANDOFF_NOTIFY_EMAIL", "APPROVAL_ALERT_OPS_EMAILS", "APPROVAL_NOTIFY_EMAIL",
  "APPROVAL_DELIVERY_FAILURE_ALERT", "AI_EMP_INQUIRY_NOTIFY_EMAIL", "BILLING_NOTIFY_EMAIL", "SUPER_ADMIN_EMAILS",
  "EMAIL_FROM", "EMAIL_FROM_UNVERIFIED", "TOMORI_WAKE_WEBHOOK_URL", "TOMORI_WAKE_WEBHOOK_SECRET", "SEALITH_AUTHORITY_EVENTS_URL",
  "APPROVAL_DEMO_STORE_URL", "APPROVAL_DEMO_STORE_TOKEN", "TELEGRAM_APPROVAL_CHAT_ID",
  // mail / chat / provider credentials
  "RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_API_TOKEN", "MAILGUN_API_KEY", "SMTP_URL", "SMTP_PASSWORD",
  "TWILIO_AUTH_TOKEN", "DISCORD_WEBHOOK_URL", "SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL", "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET", "SLACK_SHARED_APPROVAL_CLIENT_SECRET", "SLACK_SHARED_APPROVAL_SIGNING_SECRET",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OPENAI_API_KEY", "TURNSTILE_SECRET_KEY", "TWOCAPTCHA_API_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_STATE_SECRET", "GITHUB_TOKEN", "DEMO_APPROVALS_GITHUB_TOKEN",
  "VERCEL_TOKEN",
  // data stores (no URL / key → demo store, never the real one)
  "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "KV_REST_API_URL",
  "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DATABASE_URL", "POSTGRES_URL",
  // signing / encryption material
  "SEALITH_STAFFPASS_EVENT_SECRET", "STAFFPASS_SEALITH_EVENT_SECRET", "SETUP_LINK_SIGNING_SECRET",
  "VOTER_BINDING_SECRET", "CRON_SECRET", "COMM_REPLY_DEDUP_HMAC_KEY", "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
];
export const SCRUBBED_ENV_PATTERN =
  /WEBHOOK|ALERT|NOTIFY|RESEND|SENDGRID|POSTMARK|MAILGUN|SMTP|TWILIO|DISCORD|TELEGRAM|^SLACK_|_SLACK_|^LINE_|_LINE_|^STRIPE_|SUPABASE|SERVICE_ROLE|OPENAI|ANTHROPIC|^XAI_|GITHUB_TOKEN|^GH_TOKEN|VERCEL_TOKEN|^KV_REST|UPSTASH|TOMORI|SEALITH|TWOCAPTCHA|TURNSTILE_SECRET|OPS_EMAIL|_EMAILS?$|PASSWORD|_API_KEY$|_TOKEN$|_SECRET$|_SECRET_KEY$|_HMAC_KEY$|ENCRYPTION_KEY|DATABASE_URL|POSTGRES_URL/i;
for (const key of Object.keys(process.env)) {
  if (SCRUBBED_ENV_EXACT.includes(key) || SCRUBBED_ENV_PATTERN.test(key)) delete process.env[key];
}

// 2. Accidental network cannot reach real services, even if application code catches the
//    error: every un-mocked fetch, node:http(s), node:net / tls connect, DNS lookup,
//    undici request / Agent dispatch and WebSocket throws, naming the HOST only (never
//    the path, query or token), and the file fails in afterAll. fetch / http(s) refuse
//    loopback too (stricter than "non-localhost": a dev server on the box runs with the
//    real env); raw net / tls sockets may reach loopback only (a test's own server).
//    Tests that need fetch replace globalThis.fetch with a mock.
let attempted: string[] = [];
function hostOf(target: unknown): string {
  try {
    if (typeof target === "string") return new URL(target).host || "?";
    if (target instanceof URL) return target.host || "?";
    if (target && typeof target === "object") {
      const o = target as { url?: unknown; origin?: unknown; hostname?: unknown; host?: unknown; path?: unknown };
      if (typeof o.url === "string") return new URL(o.url).host || "?";
      if (o.origin) return new URL(String(o.origin)).host || "?";
      if (typeof o.hostname === "string") return o.hostname;
      if (typeof o.host === "string") return o.host;
      if (typeof o.path === "string") return `unix:${o.path}`;
    }
  } catch {
    // fall through
  }
  return typeof target === "string" ? target.split(/[/?#]/)[0] || "?" : "?";
}
function refuse(target: unknown): never {
  const host = hostOf(target);
  attempted.push(host);
  console.error(`\n[no-network] REFUSED real network call to ${host} — mock it in the test.\n`);
  throw new Error(`network_forbidden_in_local_tests: ${host}`);
}
globalThis.fetch = ((input: unknown) => refuse(input)) as unknown as typeof fetch;
(globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__ = true;
// for the harness probe only (lib/security/test-network-guard.test.ts)
(globalThis as { __STAFFPASS_NETWORK_ATTEMPTS_RESET__?: () => void }).__STAFFPASS_NETWORK_ATTEMPTS_RESET__ = () => {
  attempted = [];
};
(globalThis as { __STAFFPASS_NETWORK_ATTEMPTS__?: () => string[] }).__STAFFPASS_NETWORK_ATTEMPTS__ = () => [...attempted];

const httpForbidden = (target: unknown) => refuse(target);
// Raw sockets: only loopback is allowed (a test's own local server, e.g. the
// pinned-lookup check in lib/mcp-oauth/__tests__/cimd-ssrf.test.ts). Any other
// host, or a caller-supplied lookup that answers a non-loopback address, refuses.
const isLoopback = (address: unknown) =>
  typeof address === "string" && (/^127\./.test(address) || address === "::1" || address === "localhost");
type SocketOpts = { host?: string; path?: string; lookup?: (...a: never[]) => void };
function guardedSocket(real: (...args: never[]) => unknown) {
  return (a: unknown, b?: unknown, ...rest: unknown[]) => {
    if (typeof a === "object" && a) {
      const o = a as SocketOpts;
      if (o.path) refuse({ path: o.path });
      const host = o.host ?? "localhost";
      if (isLoopback(host)) return (real as (...x: unknown[]) => unknown)(a, b, ...rest);
      if (typeof o.lookup === "function") {
        const lookup = o.lookup as unknown as (h: string, opts: unknown, cb: (...r: unknown[]) => void) => void;
        const checked = (h: string, opts: unknown, cb: (...r: unknown[]) => void) =>
          lookup(h, opts, (err: unknown, address: unknown, family: unknown) => {
            const first = Array.isArray(address) ? (address[0] as { address?: string })?.address : address;
            if (err || !isLoopback(first)) {
              try { refuse({ hostname: host }); } catch (e) { return cb(e); }
            }
            return cb(err, address, family);
          });
        return (real as (...x: unknown[]) => unknown)({ ...o, lookup: checked }, b, ...rest);
      }
      return refuse({ hostname: host });
    }
    if (typeof a === "number") {
      const host = typeof b === "string" ? b : "localhost";
      if (isLoopback(host)) return (real as (...x: unknown[]) => unknown)(a, b, ...rest);
      return refuse({ hostname: host });
    }
    return refuse(typeof a === "string" ? { path: a } : { hostname: "?" });
  };
}
const netConnect = guardedSocket(net.connect as never);
const netCreateConnection = guardedSocket(net.createConnection as never);
const tlsConnect = guardedSocket(tls.connect as never);
const dnsForbidden = (hostname: unknown) => refuse({ hostname: String(hostname) });

mock.module("node:https", () => ({ ...https, request: httpForbidden, get: httpForbidden }));
mock.module("node:http", () => ({ ...http, request: httpForbidden, get: httpForbidden }));
mock.module("node:net", () => ({ ...net, connect: netConnect, createConnection: netCreateConnection }));
mock.module("node:tls", () => ({ ...tls, connect: tlsConnect }));
mock.module("node:dns", () => ({ ...dns, lookup: dnsForbidden, resolve: dnsForbidden, resolve4: dnsForbidden, resolve6: dnsForbidden }));
mock.module("node:dns/promises", () => ({
  ...dnsPromises, lookup: dnsForbidden, resolve: dnsForbidden, resolve4: dnsForbidden, resolve6: dnsForbidden,
}));
// undici: building an Agent / connector stays possible (lib/webhooks/link-local-guard.ts
// passes one to fetch as a dispatcher); anything that would dispatch a request refuses.
class GuardedAgent extends undici.Agent {
  override dispatch(opts: { origin?: unknown }): boolean { return refuse(opts); }
}
class GuardedPool extends undici.Pool {
  override dispatch(opts: { origin?: unknown }): boolean { return refuse(opts); }
}
class GuardedClient extends undici.Client {
  override dispatch(opts: { origin?: unknown }): boolean { return refuse(opts); }
}
const undiciForbidden = (target: unknown) => refuse(target);
mock.module("undici", () => ({
  ...undici,
  request: undiciForbidden, fetch: undiciForbidden, stream: undiciForbidden, pipeline: undiciForbidden,
  connect: undiciForbidden, upgrade: undiciForbidden,
  Agent: GuardedAgent, Pool: GuardedPool, Client: GuardedClient,
}));
if (typeof globalThis.WebSocket === "function") {
  globalThis.WebSocket = class {
    constructor(url: unknown) { refuse(url); }
  } as unknown as typeof WebSocket;
}

// 3. The channels #353 left open (木村 10/12). Loopback stays allowed for all of them.
const loopbackHost = (host: unknown) => {
  const h = String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
};
const urlHostname = (target: unknown): string => {
  try {
    if (typeof target === "string" || target instanceof URL) return new URL(String(target)).hostname;
    const o = target as { hostname?: unknown; host?: unknown } | null;
    if (o && typeof o === "object") return String(o.hostname ?? o.host ?? "");
  } catch {
    // fall through
  }
  return "";
};

// 3a. Bun.fetch is a separate, non-writable native fetch (globalThis.fetch above does
//     not cover it). Bun's fetch honours HTTP(S)_PROXY, so every non-loopback request
//     is routed to a loopback trap that records the HOST only (CONNECT host:port or the
//     absolute-URL request line, path dropped) and drops the connection, so the call
//     rejects and afterAll fails the file. curl / wget children inherit the same proxy
//     (belt and braces for 3d).
const trap = net.createServer((socket) => {
  socket.once("data", (chunk) => {
    const line = String(chunk).split("\r\n")[0] ?? "";
    const target = line.split(" ")[1] ?? "";
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? hostOf(target) : target.replace(/:\d+$/, "") || "?";
    attempted.push(host);
    console.error(`\n[no-network] REFUSED real network call to ${host} (Bun.fetch / proxied) — mock it in the test.\n`);
    socket.destroy();
  });
  socket.on("error", () => undefined);
});
await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", () => resolve()));
trap.unref();
const trapUrl = `http://127.0.0.1:${(trap.address() as { port: number }).port}`;
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) process.env[key] = trapUrl;
process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1";

// 3b. node:http2 — connect to a non-loopback authority refuses. (Real functions are
//     captured up front: mock.module updates the live namespace, so reading
//     http2.connect at call time would call this wrapper again.)
const realHttp2Connect = http2.connect as (...x: unknown[]) => unknown;
const http2Connect = (authority: unknown, ...rest: unknown[]) =>
  loopbackHost(urlHostname(authority)) ? realHttp2Connect(authority, ...rest) : refuse(authority);
const http2Module = () => ({ ...http2, connect: http2Connect, default: { ...http2, connect: http2Connect } });
mock.module("node:http2", http2Module);
mock.module("http2", http2Module);

// 3c. node:dgram — send / connect to a non-loopback address refuses (no address =
//     localhost, or the socket's own connected peer, which was checked at connect).
function guardDgram(socket: dgram.Socket): dgram.Socket {
  const send = socket.send.bind(socket) as (...x: unknown[]) => unknown;
  const connect = socket.connect.bind(socket) as (...x: unknown[]) => unknown;
  (socket as unknown as { send: unknown }).send = (...args: unknown[]) => {
    const address = args.slice(1).find((a) => typeof a === "string");
    if (address !== undefined && !loopbackHost(address)) refuse({ hostname: address });
    return send(...args);
  };
  (socket as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    const address = typeof args[1] === "string" ? args[1] : "localhost";
    if (!loopbackHost(address)) refuse({ hostname: address });
    return connect(...args);
  };
  return socket;
}
const realDgramCreateSocket = dgram.createSocket as (...x: unknown[]) => dgram.Socket;
const dgramCreateSocket = (...args: unknown[]) => guardDgram(realDgramCreateSocket(...args));
const dgramModule = () => ({ ...dgram, createSocket: dgramCreateSocket, default: { ...dgram, createSocket: dgramCreateSocket } });
mock.module("node:dgram", dgramModule);
mock.module("dgram", dgramModule);

// 3d. curl / wget (and other network CLIs) through child_process or Bun.spawn: any
//     argv / shell string naming such a tool refuses unless every host it names is
//     loopback (no host found = refuse, fail-closed). Other commands run as before.
const NET_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "telnet", "socat", "ssh", "scp", "sftp", "rsync", "ftp", "aria2c", "http", "https", "xh"]);
function networkCliHost(parts: unknown[]): string | null {
  const strings: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object" && Array.isArray((v as { cmd?: unknown }).cmd)) collect((v as { cmd: unknown[] }).cmd);
  };
  parts.forEach(collect);
  const tokens = strings.flatMap((s) => s.split(/[\s;&|()`'"<>]+/)).filter(Boolean);
  const at = tokens.findIndex((t) => NET_TOOLS.has(t.split("/").pop() ?? ""));
  if (at < 0) return null;
  const hosts: string[] = [];
  for (const t of tokens.slice(at + 1)) {
    if (t.startsWith("-")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) hosts.push(urlHostname(t) || "?");
    else {
      const m = /^(?:[^@/\s]+@)?(\[[0-9a-f:]+\]|localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(?:[/:]|$)/i.exec(t);
      if (m) hosts.push(m[1]);
    }
  }
  const external = hosts.find((h) => !loopbackHost(h));
  if (external) return external;
  return hosts.length > 0 ? null : "?";
}
function guardCli<T extends (...a: never[]) => unknown>(real: T): T {
  return ((...args: unknown[]) => {
    const host = networkCliHost(args);
    if (host !== null) refuse({ hostname: host });
    return (real as unknown as (...x: unknown[]) => unknown)(...args);
  }) as unknown as T;
}
const cpGuarded = {
  spawn: guardCli(childProcess.spawn),
  spawnSync: guardCli(childProcess.spawnSync),
  exec: guardCli(childProcess.exec),
  execSync: guardCli(childProcess.execSync),
  execFile: guardCli(childProcess.execFile),
  execFileSync: guardCli(childProcess.execFileSync),
};
const cpModule = () => ({ ...childProcess, ...cpGuarded, default: { ...childProcess, ...cpGuarded } });
mock.module("node:child_process", cpModule);
mock.module("child_process", cpModule);
// The repo has no Bun type definitions (tsc / next build); the runtime global, loosely typed.
const bunGlobal = (globalThis as unknown as { Bun: Record<string, unknown> }).Bun;
bunGlobal.spawn = guardCli(bunGlobal.spawn as (...a: never[]) => unknown);
bunGlobal.spawnSync = guardCli(bunGlobal.spawnSync as (...a: never[]) => unknown);

// 3e. Bun.connect (raw TCP / TLS): loopback only; unix sockets refuse (as for net).
const realBunConnect = bunGlobal.connect;
bunGlobal.connect = (opts: { hostname?: string; unix?: string }) => {
  if (opts?.unix) refuse({ path: opts.unix });
  if (!loopbackHost(opts?.hostname)) refuse({ hostname: String(opts?.hostname ?? "?") });
  return (realBunConnect as unknown as (o: unknown) => unknown)(opts);
};
// Bun.udpSocket: the same rule for every datagram (send / sendMany) and connect.
const realUdpSocket = bunGlobal.udpSocket;
bunGlobal.udpSocket = async (opts: { connect?: { hostname?: string } } = {}) => {
  if (opts?.connect && !loopbackHost(opts.connect.hostname)) refuse({ hostname: String(opts.connect.hostname) });
  const socket = (await (realUdpSocket as unknown as (o: unknown) => Promise<Record<string, unknown>>)(opts)) as Record<string, unknown>;
  const send = (socket.send as (...x: unknown[]) => unknown).bind(socket);
  socket.send = (data: unknown, port?: unknown, address?: unknown) => {
    if (address !== undefined && !loopbackHost(address)) refuse({ hostname: String(address) });
    return port === undefined ? send(data) : send(data, port, address);
  };
  if (typeof socket.sendMany === "function") {
    const sendMany = (socket.sendMany as (...x: unknown[]) => unknown).bind(socket);
    socket.sendMany = (packets: unknown[]) => {
      if (!opts?.connect) {
        for (let i = 2; i < packets.length; i += 3) if (!loopbackHost(packets[i])) refuse({ hostname: String(packets[i]) });
      }
      return sendMany(packets);
    };
  }
  return socket;
};

afterAll(() => {
  expect(attempted).toEqual([]);
});

// Server-only is a build boundary; fixture tests run server modules deliberately.
mock.module("server-only", () => ({}));
