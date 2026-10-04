// fail-first stub (D9) — replaced by the implementation commit
import type { PostResult, WebhookTransport } from "@/lib/mcp-events/transport";
const ni = (): never => { throw new Error("not_implemented"); };
export const WEBHOOK_FAILURE_CATEGORIES = [] as const;
export type WebhookFailureCategory = string;
export function categorizePostFailure(_r: Extract<PostResult, { ok: false }>): WebhookFailureCategory { return ni(); }
export function categorizeHttpStatus(_s: number): WebhookFailureCategory | null { return ni(); }
export function categorizeFetchError(_e: unknown): WebhookFailureCategory { return ni(); }
export function signingKeyFromSecret(_s: string | null | undefined): Buffer | null { return ni(); }
export function receiverWhsecFor(_s: string): string { return ni(); }
export function standardWebhookHeaders(_k: Buffer | null, _id: string, _ts: number, _b: string): Record<string, string> { return ni(); }
export function stableWebhookId(_p: string, _parts: string[]): string { return ni(); }
export function __setOutboundWebhookTransportForTests(_t: WebhookTransport | null): void {}
export async function postHardenedWebhook(_u: string, _b: string, _h: Record<string, string>, _o: { timeoutMs: number; userAgent?: string }): Promise<{ ok: true } | { ok: false; category: WebhookFailureCategory }> { return ni(); }
