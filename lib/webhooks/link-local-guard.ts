/**
 * Link-local / cloud-metadata destination block for the two legacy outbound
 * webhooks (Kimura 2026-10-05 08:57) — the approval.resolved callback
 * (employee.callbackUrl, lib/approvals/resolve-side-effects.ts) and the
 * conversation wake webhook (postWake, lib/slack/mention-ingress.ts).
 *
 * NO FLAG: applies while WEBHOOK_HARDENING_ENABLED is OFF (the flag-ON path is
 * #270's postHardenedWebhook, which already refuses every non-public answer).
 * Nothing else changes for the flag-OFF path: other private ranges, loopback,
 * http, any port and redirects stay exactly as today.
 *
 * How: the flag-OFF fetch gets `dispatcher: linkLocalGuardDispatcher()`, an
 * undici Agent whose connector
 *   1. refuses an IP-literal hostname in the list (net.connect does no lookup
 *      for literals), and otherwise
 *   2. connects with `lookup: guardedLookup`, which asks the resolver for ALL
 *      answers and refuses the name if ANY answer is in the list.
 * The decision is made inside net.connect on the very address it then
 * connects to (no check-then-resolve-again rebinding gap), and undici runs
 * the connector again for every redirect hop (new origin → new connection).
 * A refusal surfaces as fetch's TypeError with cause.code ADDRESS_BLOCKED_CODE,
 * which categorizeFetchError maps to "address_blocked" (category only, #270).
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector } from "undici";

export const ADDRESS_BLOCKED_CODE = "ERR_STAFFPASS_ADDRESS_BLOCKED";

/**
 * The single list. Only well-documented link-local ranges and provider
 * metadata endpoints. IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96),
 * IPv4-translated (::ffff:0:0:0/96) and NAT64 well-known-prefix
 * (64:ff9b::/96, RFC 6052) spellings of every IPv4 entry are derived from it.
 */
export const LINK_LOCAL_METADATA_BLOCKLIST: ReadonlyArray<{ readonly cidr: string; readonly note: string }> = [
  {
    cidr: "169.254.0.0/16",
    note: "IPv4 link-local (RFC 3927). Includes 169.254.169.254 (AWS EC2 / GCP / Azure IMDS / OCI instance metadata), "
      + "169.254.170.2 (AWS ECS task metadata + credentials), 169.254.170.23 (AWS EKS Pod Identity agent), 169.254.0.23 (Tencent Cloud metadata)",
  },
  { cidr: "100.100.100.200/32", note: "Alibaba Cloud ECS instance metadata" },
  { cidr: "192.0.0.192/32", note: "Oracle Cloud Infrastructure Classic instance metadata" },
  { cidr: "fe80::/10", note: "IPv6 link-local unicast (RFC 4291)" },
  { cidr: "fd00:ec2::254/128", note: "AWS EC2 IMDS IPv6 endpoint" },
  { cidr: "fd00:ec2::23/128", note: "AWS EKS Pod Identity agent IPv6 endpoint" },
  { cidr: "fd20:ce::254/128", note: "Google Compute Engine metadata server IPv6 endpoint" },
];

function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** 8 × 16-bit words, or null. Accepts "::", a trailing dotted quad, a %zone. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    s = s.slice(0, lastColon + 1); // keep the ':' so "::" / "x:" stays well-formed
    if (s.endsWith("::")) { /* "::a.b.c.d" or "x::a.b.c.d" */ } else s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const fill = halves.length === 2 ? new Array<number>(8 - explicit).fill(0) : [];
  return [...head.map((g) => parseInt(g, 16)), ...fill, ...rest.map((g) => parseInt(g, 16)), ...tail];
}

type V4Rule = { base: number; mask: number };
type V6Rule = { words: number[]; prefix: number };
const V4_RULES: V4Rule[] = [];
const V6_RULES: V6Rule[] = [];
for (const { cidr } of LINK_LOCAL_METADATA_BLOCKLIST) {
  const [addr, len] = cidr.split("/");
  const prefix = Number(len);
  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    V4_RULES.push({ base: (v4 & mask) >>> 0, mask });
  } else {
    const words = parseIPv6(addr);
    if (!words) throw new Error(`link-local guard: bad CIDR ${cidr}`);
    V6_RULES.push({ words, prefix });
  }
}

const v4Blocked = (n: number) => V4_RULES.some((r) => ((n & r.mask) >>> 0) === r.base);
function v6Matches(w: number[], r: V6Rule): boolean {
  for (let i = 0, bits = r.prefix; bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((w[i] & mask) !== (r.words[i] & mask)) return false;
  }
  return true;
}
/** IPv4 carried in a mapped / compatible / translated / NAT64 (64:ff9b::/96) address. */
function embeddedIPv4(w: number[]): number | null {
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  const carried =
    (zero(0, 5) && w[5] === 0xffff) // ::ffff:a.b.c.d (IPv4-mapped)
    || zero(0, 6) // ::a.b.c.d (IPv4-compatible, deprecated)
    || (zero(0, 4) && w[4] === 0xffff && w[5] === 0) // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
    || (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)); // 64:ff9b::a.b.c.d (NAT64 well-known prefix, RFC 6052)
  return carried ? ((w[6] << 16) | w[7]) >>> 0 : null;
}

const unbracket = (s: string) => (s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s);

/** True only for an IP address (v4 or v6, any spelling) covered by the list. */
export function isLinkLocalOrMetadataAddress(ip: string): boolean {
  const s = unbracket(String(ip ?? "").trim());
  const v4 = parseIPv4(s);
  if (v4 !== null) return v4Blocked(v4);
  const w = parseIPv6(s);
  if (!w) return false;
  if (V6_RULES.some((r) => v6Matches(w, r))) return true;
  const carried = embeddedIPv4(w);
  return carried !== null && v4Blocked(carried);
}

function addressBlockedError(): NodeJS.ErrnoException {
  // Deliberately carries no hostname / address: callers expose the category only.
  return Object.assign(new Error("destination is a link-local or cloud metadata address"), { code: ADDRESS_BLOCKED_CODE });
}

type Answer = { address: string; family: number };
export type LinkLocalGuardResolver = (
  hostname: string,
  options: Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, addresses: Answer[]) => void,
) => void;
const systemResolver: LinkLocalGuardResolver = (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => callback(err, addresses || []));
let testResolver: LinkLocalGuardResolver | null = null;
/** Tests only: replace the system resolver (null restores it). */
export function __setLinkLocalGuardResolverForTests(resolver: LinkLocalGuardResolver | null): void {
  testResolver = resolver;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | Answer[], family?: number) => void;
/**
 * dns.lookup-compatible (net.connect `lookup` option). Always resolves ALL
 * answers; if any is in the list the name is refused, otherwise the answers
 * are returned as the resolver gave them (first one, or all when asked).
 */
export function guardedLookup(hostname: string, options: unknown, callback?: LookupCallback): void {
  let cb = callback;
  let opts: Record<string, unknown> = {};
  if (typeof options === "function") cb = options as LookupCallback;
  else if (typeof options === "number") opts = { family: options };
  else if (options && typeof options === "object") opts = { ...(options as Record<string, unknown>) };
  if (!cb) throw new TypeError("guardedLookup: callback required");
  const done = cb;
  const wantAll = opts.all === true;
  (testResolver ?? systemResolver)(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return done(err);
    const list = (addresses || []).map((a) => ({ address: a.address, family: a.family }));
    if (list.length === 0) return done(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    if (list.some((a) => isLinkLocalOrMetadataAddress(a.address))) return done(addressBlockedError());
    if (wantAll) return done(null, list);
    return done(null, list[0].address, list[0].family);
  });
}

type Connector = buildConnector.connector;
/** Wrap an undici connector: blocked IP-literal hosts never reach it. */
export function createGuardedConnect(base: Connector): Connector {
  return ((options, callback) => {
    const host = unbracket(String(options.hostname ?? ""));
    if (isIP(host) && isLinkLocalOrMetadataAddress(host)) {
      (callback as (err: Error, socket: null) => void)(addressBlockedError(), null);
      return;
    }
    return base(options, callback);
  }) as Connector;
}

let agent: Agent | null = null;
/** One shared Agent for both legacy webhooks (keep-alive pool like the global one). */
export function linkLocalGuardDispatcher(): Agent {
  agent ??= new Agent({ connect: createGuardedConnect(buildConnector({ lookup: guardedLookup as never })) });
  return agent;
}

/** The flag-OFF request init plus the guard dispatcher; nothing else changes. */
export function withLinkLocalGuard(init: RequestInit): RequestInit {
  return { ...init, dispatcher: linkLocalGuardDispatcher() } as RequestInit;
}
