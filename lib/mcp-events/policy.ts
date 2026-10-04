/**
 * MCP Events subscription policy: TTL grant, the cap that shortens risky
 * subscriptions, and server-side limits. refreshBefore is ALWAYS finite here
 * (ttlMs: null is granted the class maximum): ChatGPT does not support the
 * `terminated` envelope, so expiry is the backstop that ends deliveries the
 * server can no longer stop by itself (e.g. a receiver that never refreshes).
 */
export const MCP_EVENTS_LIMITS = {
  minTtlMs: 5 * 60_000,
  defaultTtlMs: 60 * 60_000,
  maxTtlMs: 24 * 60 * 60_000,
  elevatedDefaultTtlMs: 15 * 60_000,
  elevatedMaxTtlMs: 60 * 60_000,
  maxSubscriptionsPerEmployee: 20,
  maxBodyBytes: 256 * 1024,
  maxAttempts: 4,
  retryWindowMs: 15 * 60_000,
  /** delay before attempt 2, 3, 4 */
  backoffMs: [30_000, 2 * 60_000, 8 * 60_000],
  attemptTimeoutMs: 5_000,
  verificationCacheMs: 24 * 60 * 60_000,
  verificationsPerHostPerMinute: 30,
  attributionWindowMs: 30 * 60_000,
} as const;

export type SubscriptionRisk = "standard" | "elevated";
export type RiskReason = "receiver_not_allowlisted" | "includes_high_risk_approvals" | "no_expiry_requested";

/** Comma-separated exact hostnames (env MCP_EVENTS_TRUSTED_RECEIVER_HOSTS). Not tenant-specific. */
export function trustedReceiverHosts(): Set<string> {
  return new Set(
    (process.env.MCP_EVENTS_TRUSTED_RECEIVER_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function classifySubscriptionRisk(input: {
  host: string;
  args: { risk?: string[] } & Record<string, unknown>;
  requestedTtlMs: number | null | undefined;
}): { risk: SubscriptionRisk; reasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  if (!trustedReceiverHosts().has(input.host.toLowerCase())) reasons.push("receiver_not_allowlisted");
  const risks = Array.isArray(input.args.risk) ? input.args.risk : null;
  if (!risks || risks.includes("high")) reasons.push("includes_high_risk_approvals");
  if (input.requestedTtlMs === null) reasons.push("no_expiry_requested");
  return { risk: reasons.length ? "elevated" : "standard", reasons };
}

export function grantSubscriptionTtl(input: {
  requestedTtlMs: number | null | undefined;
  risk: SubscriptionRisk;
}): { ttlMs: number; capped: boolean } {
  const L = MCP_EVENTS_LIMITS;
  const max = input.risk === "elevated" ? L.elevatedMaxTtlMs : L.maxTtlMs;
  const def = input.risk === "elevated" ? L.elevatedDefaultTtlMs : L.defaultTtlMs;
  const req = input.requestedTtlMs;
  if (req === null) return { ttlMs: max, capped: true };
  if (typeof req !== "number" || !Number.isFinite(req) || req <= 0) return { ttlMs: def, capped: false };
  if (req > max) return { ttlMs: max, capped: true };
  return { ttlMs: Math.max(L.minTtlMs, Math.floor(req)), capped: false };
}
