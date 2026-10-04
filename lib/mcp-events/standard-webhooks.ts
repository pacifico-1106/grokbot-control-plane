export const parseWhsecSecret = ((..._a: unknown[]) => { throw new Error("not_implemented"); }) as (v: unknown) => { ok: true; key: Buffer } | { ok: false; reason: string };
export const signStandardWebhook = ((..._a: unknown[]) => { throw new Error("not_implemented"); }) as (k: Buffer[], id: string, ts: number, body: string) => string;
export const verifyStandardWebhook = ((..._a: unknown[]) => { throw new Error("not_implemented"); }) as (k: Buffer, h: { id: string; timestamp: string; signature: string }, body: string, o?: { nowSec?: number }) => boolean;
