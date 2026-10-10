/** SSRF guard helpers for outbound CIMD fetches (S8). */
import { isIP } from "node:net";

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x.replace(/^0+/, ""));
  }
  return true; // not an IP → treat as unsafe
}

export type HostResolver = (host: string) => Promise<string[]>;

export const defaultResolver: HostResolver = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};
