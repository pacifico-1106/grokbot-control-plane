// TDD stub (replaced by the implementation in the next commit): permissive,
// so the new tests show what is missing.
import { lookup as dnsLookup } from "node:dns";
export const ADDRESS_BLOCKED_CODE = "ERR_STAFFPASS_ADDRESS_BLOCKED";
export const LINK_LOCAL_METADATA_BLOCKLIST: ReadonlyArray<{ cidr: string; note: string }> = [];
export function isLinkLocalOrMetadataAddress(_ip: string): boolean { return false; }
type Resolver = (host: string, options: Record<string, unknown>, cb: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => void;
let resolver: Resolver | null = null;
export function __setLinkLocalGuardResolverForTests(r: Resolver | null) { resolver = r; }
export function guardedLookup(hostname: string, options: unknown, callback: (...a: unknown[]) => void) {
  const opts = (typeof options === "object" && options ? options : {}) as Record<string, unknown>;
  const r = resolver ?? ((h, o, cb) => dnsLookup(h, { ...o, all: true } as never, cb as never));
  r(hostname, { ...opts, all: true }, (err, list) => err ? callback(err) : opts.all ? callback(null, list) : callback(null, list[0].address, list[0].family));
}
export function createGuardedConnect(base: unknown) { return base; }
const dispatcher = {};
export function linkLocalGuardDispatcher() { return dispatcher; }
export function withLinkLocalGuard(init: RequestInit): RequestInit { return init; }
