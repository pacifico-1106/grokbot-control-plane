const ni = (..._a: unknown[]): never => { throw new Error("not_implemented"); };
export const canonicalJson = ni as (v: unknown) => string;
export const subscriptionId = ni as (v: unknown) => string;
export const approvalEventId = ni as (v: unknown) => string;
