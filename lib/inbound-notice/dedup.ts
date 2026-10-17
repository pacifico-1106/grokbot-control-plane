/** Primary dedup key: Slack channel + message ts (not event_id). */
export function inboundNoticeDedupKey(channel: string, ts: string): string | null {
  const ch = channel.trim();
  const t = ts.trim();
  if (!ch || !t) return null;
  return `inb:${ch}:${t}`;
}

/** Stable jobId for staffpass_invoke (charset: A-Za-z0-9 _ . : / - , ≤128). */
export function inboundNoticeJobId(channel: string, ts: string): string {
  const raw = `inb_${channel.trim()}_${ts.trim()}`.replace(/[^A-Za-z0-9_.:/-]/g, "_");
  return raw.slice(0, 128) || "inb_unknown";
}
