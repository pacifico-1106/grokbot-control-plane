import { parseInboundNoticeFields } from "@/lib/inbound-notice/parse";
import { INBOUND_NOTICE_SCHEMA, type InboundNoticeAdapter } from "@/lib/inbound-notice/types";

const MARKER = "受電のお知らせ";

export const aiConcierAdapter: InboundNoticeAdapter = {
  id: "ai-concier",
  source: "ai_concier",
  matches(input) {
    return (input.text || "").includes(MARKER);
  },
  parse(input) {
    if (!this.matches(input)) return null;
    return {
      schema: INBOUND_NOTICE_SCHEMA,
      source: "ai_concier",
      adapterId: "ai-concier",
      fields: parseInboundNoticeFields(input.text),
    };
  },
};
