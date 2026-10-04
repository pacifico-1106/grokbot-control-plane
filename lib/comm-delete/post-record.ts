/** Records of posts Staffpass made (fail-first stub). */
export type PostRecord = {
  v: 1;
  surface: "slack";
  channel: string;
  messageId: string;
  postedVia: "user" | "bot";
};

export function buildSlackPostRecord(_delivery: unknown): PostRecord | null {
  return null;
}
