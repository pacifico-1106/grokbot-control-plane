const ni = (..._a: unknown[]): never => { throw new Error("not_implemented"); };
export const MCP_EVENTS_LIMITS = {} as Record<string, number>;
export const classifySubscriptionRisk = ni as (v: unknown) => { risk: string; reasons: string[] };
export const grantSubscriptionTtl = ni as (v: unknown) => { ttlMs: number; capped: boolean };
