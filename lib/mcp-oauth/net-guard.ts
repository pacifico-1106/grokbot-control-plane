/**
 * SSRF guard helpers for outbound CIMD fetches (S8, hardened in reland-8).
 *
 * - isPrivateAddress delegates to lib/security/public-file-download.ts
 *   isPublicDownloadAddress (node:net BlockList, so every spelling is parsed,
 *   not prefix-matched): IPv4 private / loopback / link-local + metadata
 *   (169.254.0.0/16) / CGNAT (100.64.0.0/10, incl. 100.100.100.200) /
 *   benchmarking / documentation / multicast / reserved are refused, and for
 *   IPv6 ONLY global unicast 2000::/3 is accepted, minus Teredo / ORCHID
 *   (2001::/23), documentation (2001:db8::/32, 3fff::/20) and 6to4
 *   (2002::/16). Loopback, unspecified, ULA (fc00::/7, incl. fd00:ec2::254 and
 *   fd20:ce::254), link-local, site-local, multicast, IPv4-mapped /
 *   -compatible / -translated and NAT64 (64:ff9b::/96, 64:ff9b:1::/48) are
 *   all outside 2000::/3 and therefore refused. Anything that is not an IP
 *   literal is refused.
 * - pinnedLookup is a dns.lookup-compatible function that only ever answers
 *   the one address we already checked (used as the socket's `lookup`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isPublicDownloadAddress } from "@/lib/security/public-file-download";

export function isPrivateAddress(ip: string): boolean {
  return !isPublicDownloadAddress(String(ip ?? ""));
}

export type ResolvedAnswer = { address: string; family: 4 | 6 };
export type HostResolver = (host: string) => Promise<ResolvedAnswer[]>;

/** All answers, resolver order (verbatim), resolved ONCE per fetch. */
export const defaultResolver: HostResolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** dns.lookup-compatible: whatever is asked, answer only the pinned (already checked) address. */
export function pinnedLookup(pinned: ResolvedAnswer): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as LookupFunction;
}
