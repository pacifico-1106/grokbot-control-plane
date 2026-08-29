/**
 * Staffpass Slack mention ingress (Event Subscriptions).
 * Cursor Slack は使わない。署名は SLACK_SIGNING_SECRET、
 * 未設定なら承認用 Slack 通知チャネルの signingSecret。
 */

import { appendAuditEvent } from "@/lib/data/audit";
import {
  getEmployeesBySlackUserIds,
  listLinkedSlackIdentitiesForTeam,
  type SlackMentionTarget,
} from "@/lib/data/slack-identities";
import { getWakeWebhookSecret } from "@/lib/data/bindings";
import { listAllEnabledNotificationChannels } from "@/lib/data/notification-channels";
import { isDemoMode } from "@/lib/mode";
import { verifySlackSignature } from "@/lib/notify/slack";
import { createSupabaseAdminClient } from "@/lib/supabase";

const WAKE_TIMEOUT_MS = 2_500;
const MENTION_RE = /<@([UW][A-Z0-9_]+)(?:\|[^>]+)?>/gi;
const USER_ID_RE = /^[UW][A-Z0-9_]+$/i;
const SKIP_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
]);

const demoClaimedEvents = new Set<string>();

export type SlackWakePayload = {
  channel: string;
  ts: string;
  thread_ts: string | null;
  text: string;
  user: string;
  slackUserId: string;
  teamId: string;
  employeeId: string;
  eventId: string;
};

type SlackEvent = {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: unknown;
  blocks?: unknown;
};

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
};

export async function resolveSlackSigningSecret(): Promise<string> {
  const env = process.env.SLACK_SIGNING_SECRET?.trim() || "";
  if (env) return env;
  const channels = await listAllEnabledNotificationChannels();
  for (const channel of channels) {
    if (channel.provider !== "slack") continue;
    const secret = channel.secrets.signingSecret?.trim() || "";
    if (secret) return secret;
  }
  return "";
}

export function extractMentionedUserIds(
  text: string,
  blocks?: unknown
): string[] {
  const ids = new Set<string>();
  const scan = (value: string) => {
    MENTION_RE.lastIndex = 0;
    for (const match of value.matchAll(MENTION_RE)) {
      const id = match[1]?.toUpperCase();
      if (id) ids.add(id);
    }
  };
  if (text) scan(text);
  walkBlocks(blocks, ids, scan);
  return [...ids];
}

function walkBlocks(
  value: unknown,
  ids: Set<string>,
  scan: (text: string) => void
): void {
  if (typeof value === "string") {
    scan(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkBlocks(item, ids, scan);
    return;
  }
  if (!value || typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  if (rec.type === "user" && typeof rec.user_id === "string" && USER_ID_RE.test(rec.user_id)) {
    ids.add(rec.user_id.toUpperCase());
  }
  if (typeof rec.user === "string" && USER_ID_RE.test(rec.user)) {
    ids.add(rec.user.toUpperCase());
  }
  for (const nested of Object.values(rec)) walkBlocks(nested, ids, scan);
}

export async function claimSlackMentionEvent(eventId: string): Promise<boolean> {
  const id = eventId.trim();
  if (!id) return false;
  if (isDemoMode()) {
    if (demoClaimedEvents.has(id)) return false;
    demoClaimedEvents.add(id);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    if (demoClaimedEvents.has(id)) return false;
    demoClaimedEvents.add(id);
    return true;
  }
  const { data, error } = await admin
    .from("slack_mention_events")
    .insert({ event_id: id })
    .select("event_id")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return false;
    console.error("slack_mention_event_claim_failed", error);
    return false;
  }
  return Boolean(data?.event_id);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shouldIgnoreEvent(event: SlackEvent): boolean {
  const subtype = str(event.subtype);
  if (SKIP_SUBTYPES.has(subtype)) return true;
  if (str(event.bot_id) || event.bot_profile) return true;
  return false;
}

async function resolveWakeTargets(input: {
  eventType: string;
  mentionedIds: string[];
  teamId: string;
  speakerId: string;
}): Promise<SlackMentionTarget[]> {
  const mentioned = await getEmployeesBySlackUserIds(input.mentionedIds, input.teamId);
  const speakerRows = input.speakerId
    ? await getEmployeesBySlackUserIds([input.speakerId], input.teamId)
    : [];
  const speakerBound = speakerRows.length > 0;
  const others = mentioned.filter(
    (row) => row.slackUserId.toUpperCase() !== input.speakerId.toUpperCase()
  );

  if (input.eventType === "app_mention") {
    if (others.length) return others;
    if (mentioned.length) return mentioned;
    const teamLinked = await listLinkedSlackIdentitiesForTeam(input.teamId || null);
    if (teamLinked.length === 1) return teamLinked;
    return [];
  }

  // Own loop: message from a bound identity that does not mention another bound identity.
  if (speakerBound && others.length === 0) return [];
  return others;
}

async function postWake(
  target: SlackMentionTarget,
  payload: SlackWakePayload
): Promise<void> {
  const url = target.wakeWebhookUrl?.trim() || "";
  if (!url) {
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "wake_webhook_missing",
      metadata: {
        reason: "wake_webhook_missing",
        channel: payload.channel,
        ts: payload.ts,
        eventId: payload.eventId,
        slackUserId: target.slackUserId,
      },
    }).catch(() => undefined);
    return;
  }
  const secret = await getWakeWebhookSecret(target.employeeId);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) headers.authorization = `Bearer ${secret}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("slack_mention_wake_http", target.employeeId, response.status);
      await appendAuditEvent({
        orgId: target.orgId,
        employeeId: target.employeeId,
        credentialId: null,
        action: "slack.mention_wake",
        purpose: "slack.mention",
        summary: "起こす webhook の送信に失敗",
        metadata: {
          reason: "wake_failed",
          status: response.status,
          eventId: payload.eventId,
        },
      }).catch(() => undefined);
      return;
    }
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "Slackメンションで社員を起こした",
      metadata: {
        reason: "woke",
        channel: payload.channel,
        ts: payload.ts,
        thread_ts: payload.thread_ts,
        eventId: payload.eventId,
      },
    }).catch(() => undefined);
  } catch (error) {
    console.error("slack_mention_wake_failed", target.employeeId, error);
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action: "slack.mention_wake",
      purpose: "slack.mention",
      summary: "起こす webhook の送信に失敗",
      metadata: {
        reason: "wake_failed",
        error: error instanceof Error ? error.message : "wake_failed",
        eventId: payload.eventId,
      },
    }).catch(() => undefined);
  }
}

export async function processSlackMentionEnvelope(
  envelope: SlackEnvelope
): Promise<{ handled: boolean; woke: number; duplicate?: boolean }> {
  const event = envelope.event;
  const eventId = str(envelope.event_id);
  const eventType = str(event?.type);
  if (!event || !eventId) return { handled: false, woke: 0 };
  if (eventType !== "app_mention" && eventType !== "message") {
    return { handled: false, woke: 0 };
  }
  if (shouldIgnoreEvent(event)) return { handled: true, woke: 0 };

  const claimed = await claimSlackMentionEvent(eventId);
  if (!claimed) return { handled: true, woke: 0, duplicate: true };

  const teamId = str(envelope.team_id);
  const speakerId = str(event.user);
  const text = typeof event.text === "string" ? event.text : "";
  const mentionedIds = extractMentionedUserIds(text, event.blocks);
  const targets = await resolveWakeTargets({
    eventType,
    mentionedIds,
    teamId,
    speakerId,
  });
  if (!targets.length) return { handled: true, woke: 0 };

  const channel = str(event.channel);
  const ts = str(event.ts);
  const threadTs = str(event.thread_ts) || null;
  let woke = 0;
  for (const target of targets) {
    const payload: SlackWakePayload = {
      channel,
      ts,
      thread_ts: threadTs,
      text,
      user: speakerId,
      slackUserId: target.slackUserId,
      teamId,
      employeeId: target.employeeId,
      eventId,
    };
    await postWake(target, payload);
    if (target.wakeWebhookUrl?.trim()) woke += 1;
  }
  return { handled: true, woke };
}

export async function handleSlackEventsRequest(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const signingSecret = await resolveSlackSigningSecret();
  const verified = verifySlackSignature({
    signingSecret,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
    signature: input.signature,
  });
  if (!verified) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  let envelope: SlackEnvelope = {};
  try {
    envelope = JSON.parse(input.rawBody || "{}") as SlackEnvelope;
  } catch {
    return { status: 200, body: { ok: true } };
  }

  if (envelope.type === "url_verification") {
    return { status: 200, body: { challenge: envelope.challenge } };
  }

  try {
    await processSlackMentionEnvelope(envelope);
  } catch (error) {
    console.error("slack_events_handle_failed", error);
  }
  return { status: 200, body: { ok: true } };
}
