/**
 * Slack mention-ingress hook. Flag OFF → caller never imports this path.
 * Candidate detection requires a bot identity AND an adapter match so a
 * human paste of 受電のお知らせ does not change existing mention behavior.
 */
import { handleInboundNotice, type InboundNoticeOutcome } from "@/lib/inbound-notice/intake";
import { matchInboundNoticeAdapter } from "@/lib/inbound-notice/adapters";

type Slackish = {
  team_id?: unknown;
  event_id?: unknown;
  event?: {
    type?: unknown;
    subtype?: unknown;
    text?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    channel?: unknown;
    bot_id?: unknown;
    app_id?: unknown;
    bot_profile?: unknown;
    blocks?: unknown;
  };
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function walkText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkText(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") out.push(rec.text);
  for (const nested of Object.values(rec)) {
    if (nested === rec.text) continue;
    walkText(nested, out);
  }
}

export function extractInboundNoticeText(event: Slackish["event"]): string {
  const parts: string[] = [];
  if (typeof event?.text === "string" && event.text) parts.push(event.text);
  if (event?.blocks) walkText(event.blocks, parts);
  return parts.join("\n");
}

function botIds(event: Slackish["event"]): { botId: string; appId: string } {
  const profile =
    event?.bot_profile && typeof event.bot_profile === "object"
      ? (event.bot_profile as Record<string, unknown>)
      : null;
  const botId = str(event?.bot_id) || str(profile?.id);
  const appId = str(event?.app_id) || str(profile?.app_id);
  return { botId, appId };
}

function hasBotIdentity(event: Slackish["event"]): boolean {
  const { botId, appId } = botIds(event);
  return Boolean(botId || appId || str(event?.subtype) === "bot_message");
}

export function isInboundNoticeCandidate(envelope: unknown): boolean {
  const env = envelope as Slackish;
  const event = env.event;
  if (!event) return false;
  if (!hasBotIdentity(event)) return false;
  return matchInboundNoticeAdapter(extractInboundNoticeText(event)) !== null;
}

export async function handleInboundNoticeEnvelope(envelope: unknown): Promise<InboundNoticeOutcome> {
  const env = envelope as Slackish;
  const event = env.event;
  const { botId, appId } = botIds(event);
  return handleInboundNotice({
    teamId: str(env.team_id),
    eventId: str(env.event_id),
    channelId: str(event?.channel),
    ts: str(event?.ts),
    threadTs: str(event?.thread_ts) || null,
    text: extractInboundNoticeText(event),
    botId,
    appId,
    subtype: str(event?.subtype),
  });
}
