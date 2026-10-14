/**
 * Per-employee LINE webhook ref lookup. Isolated so tests can inject a
 * throwing backend without exporting a hook from the Next.js route module
 * (route files may only export HTTP handlers).
 */
import { getActiveCommAccountByWebhookRef, type CommAccount } from "@/lib/comm/accounts";

type RefLookup = (ref: string) => Promise<CommAccount | null>;
let lookupRef: RefLookup = getActiveCommAccountByWebhookRef;

/** Tests only. */
export function __setLineWebhookRefLookupForTests(fn: RefLookup | null): void {
  lookupRef = fn ?? getActiveCommAccountByWebhookRef;
}

export async function resolveActiveCommAccountByWebhookRef(ref: string): Promise<CommAccount | null> {
  return lookupRef(ref);
}
