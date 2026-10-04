const ni = (..._a: unknown[]): never => { throw new Error("not_implemented"); };
export type PinnedRequest = { address: string; family: 4 | 6; hostname: string; path: string; headers: Record<string, string>; body: Buffer };
export type WebhookTransport = { lookup: (h: string) => Promise<Array<{ address: string; family: 4 | 6 }>>; request: (r: PinnedRequest) => Promise<{ status: number; body: Buffer }> };
export const validateCallbackUrl = ni as (u: string) => { ok: boolean; host?: string };
export const postWebhook = ni as (u: string, b: string, h: Record<string, string>, t: WebhookTransport) => Promise<{ ok: true; status: number } | { ok: false; reason: string; category: string; retryable: boolean; status?: number }>;
export const buildPinnedRequestOptions = ni as (r: PinnedRequest) => Record<string, unknown>;
