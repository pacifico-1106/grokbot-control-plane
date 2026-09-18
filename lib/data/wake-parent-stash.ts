/**
 * Wake Parent Stash — server-side short-lived mapping for prefer_thread injection.
 *
 * When a mention wake event is successfully sent to an employee's webhook,
 * store the parent message ts so that if the client invoke does not forward
 * the wake ts, prefer_thread policy can still inject the correct thread_ts.
 *
 * Key: employeeId + channelId (scoped to org for tenant isolation)
 * Value: { parentTs, eventId, expiresAt }
 *
 * TTL: 15 minutes (a human response window)
 * Fail-closed: 0 or ambiguous matches → do not inject
 *
 * Security: tenant isolation ensured by orgId prefix in key
 */

const STASH_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface WakeParentEntry {
  parentTs: string;
  eventId: string;
  expiresAt: number;
  orgId: string;
  channelId: string;
  employeeId: string;
}

/**
 * In-memory stash. Production could use Redis/KV with TTL.
 * Key format: `${orgId}:${employeeId}:${channelId}`
 */
const stash = new Map<string, WakeParentEntry>();

function stashKey(orgId: string, employeeId: string, channelId: string): string {
  return `${orgId}:${employeeId}:${channelId}`;
}

/**
 * Store a wake parent ts for later prefer_thread lookup.
 * Called after a successful wake webhook delivery.
 */
export function storeWakeParent(input: {
  orgId: string;
  employeeId: string;
  channelId: string;
  parentTs: string;
  eventId: string;
}): void {
  const key = stashKey(input.orgId, input.employeeId, input.channelId);
  const expiresAt = Date.now() + STASH_TTL_MS;

  stash.set(key, {
    parentTs: input.parentTs,
    eventId: input.eventId,
    expiresAt,
    orgId: input.orgId,
    channelId: input.channelId,
    employeeId: input.employeeId,
  });
}

/**
 * Look up a wake parent ts for prefer_thread injection.
 * Returns the entry if found and not expired, null otherwise.
 *
 * Fail-closed: returns null if expired or not found.
 * Does NOT consume the entry — multiple invokes in the same thread
 * should all be able to use the same parent ts.
 */
export function lookupWakeParent(input: {
  orgId: string;
  employeeId: string;
  channelId: string;
}): WakeParentEntry | null {
  const key = stashKey(input.orgId, input.employeeId, input.channelId);
  const entry = stash.get(key);

  if (!entry) {
    return null;
  }

  // Check expiry
  if (Date.now() > entry.expiresAt) {
    stash.delete(key);
    return null;
  }

  // Verify tenant isolation (defense in depth)
  if (entry.orgId !== input.orgId) {
    return null;
  }

  return entry;
}

/**
 * Consume and remove a wake parent entry.
 * Call this after successfully using the entry for thread_ts injection
 * to prevent stale entries from accumulating.
 *
 * Optional — entries expire naturally after TTL.
 */
export function consumeWakeParent(input: {
  orgId: string;
  employeeId: string;
  channelId: string;
}): WakeParentEntry | null {
  const key = stashKey(input.orgId, input.employeeId, input.channelId);
  const entry = stash.get(key);

  if (!entry) {
    return null;
  }

  // Check expiry
  if (Date.now() > entry.expiresAt) {
    stash.delete(key);
    return null;
  }

  // Verify tenant isolation (defense in depth)
  if (entry.orgId !== input.orgId) {
    return null;
  }

  stash.delete(key);
  return entry;
}

/**
 * Clear expired entries from the stash.
 * Call periodically to prevent memory leaks.
 */
export function cleanupExpiredEntries(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of stash) {
    if (now > entry.expiresAt) {
      stash.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Get the current stash size (for monitoring/testing).
 */
export function getStashSize(): number {
  return stash.size;
}

/**
 * Clear all entries (for testing).
 */
export function clearStash(): void {
  stash.clear();
}

/**
 * Export stash TTL for documentation/testing.
 */
export const WAKE_PARENT_STASH_TTL_MS = STASH_TTL_MS;
