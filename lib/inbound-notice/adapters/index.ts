import { aiConcierAdapter } from "@/lib/inbound-notice/adapters/ai-concier";
import type { InboundNotice, InboundNoticeAdapter } from "@/lib/inbound-notice/types";

/**
 * First adapter: ai-concier only.
 * Voicemail and forwarded-email adapters are deferred (木村 2026-10-16) —
 * do not register them here until a later PR.
 */
export const INBOUND_NOTICE_ADAPTERS: readonly InboundNoticeAdapter[] = [aiConcierAdapter];

export function matchInboundNoticeAdapter(text: string): InboundNoticeAdapter | null {
  return INBOUND_NOTICE_ADAPTERS.find((a) => a.matches({ text })) ?? null;
}

export function parseWithAdapters(text: string): InboundNotice | null {
  const adapter = matchInboundNoticeAdapter(text);
  return adapter?.parse({ text }) ?? null;
}
