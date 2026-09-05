/**
 * Staffpass Slack mention ingress (Event Subscriptions).
 * Cursor Slack は使わない。署名は SLACK_SIGNING_SECRET、
 * 未設定なら承認用 Slack 通知チャネルの signingSecret。
 *
 * Path A: Bot message.im — Staffpass app との app-DM（Bot Events）
 * Path B: User-token message.im — human↔human DM（Subscribe to events on behalf of users）
 *
 * Path B は社員が im:history スコープで再 OAuth 後、Slack app 設定で
 * "Subscribe to events on behalf of users" の message.im を有効化すると動作。
 */

import { appendAuditEvent } from "@/lib/data/audit";
import {
  getEmployeesBySlackUserIds,
  listLinkedSlackIdentitiesForTeam,
  type SlackMentionTarget,
} from "@/lib/data/slack-identities";
import { getWakeWebhookSecret } from "@/lib/data/bindings";
import {
  isSlackImChannelId,
  resolveSlackImWakeTarget,
  resolveSlackUserTokenImWakeTarget,
} from "@/lib/data/slack-im-routes";
import { listAllEnabledNotificationChannels } from "@/lib/data/notification-channels";
import { isDemoMode } from "@/lib/mode";
import { verifySlackSignature } from "@/lib/notify/slack";
import { createSupabaseAdminClient } from "@/lib/supabase";

const WAKE_TIMEOUT_MS = 10_000;
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
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: unknown;
  blocks?: unknown;
};

type SlackAuthorization = {
  is_bot?: boolean;
  user_id?: string;
  team_id?: string;
};

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
  authorizations?: SlackAuthorization[];
};

/**
 * Safely check if is_bot is falsy (handles boolean false, string "false", undefined).
 * Slack typically sends boolean, but defensive coercion handles edge cases.
 */
function isBotFalse(value: unknown): boolean {
  if (value === false) return true;
  if (value === "false") return true;
  return false;
}

/**
 * Extract the first user-token authorization from the envelope.
 * User-token events have authorizations[].is_bot = false.
 * Returns null for bot-token events or missing authorizations.
 */
function extractUserTokenAuthorization(
  envelope: SlackEnvelope
): SlackAuthorization | null {
  const auths = envelope.authorizations;
  if (!auths || !Array.isArray(auths)) return null;
  for (const auth of auths) {
    if (auth && isBotFalse(auth.is_bot) && auth.user_id) {
      return auth;
    }
  }
  return null;
}

/**
 * Summarize authorizations for logging (redact full user_id).
 */
function summarizeAuthorizations(
  auths: SlackAuthorization[] | undefined
): string {
  if (!auths || !Array.isArray(auths) || auths.length === 0) return "none";
  return auths
    .map((a) => {
      const bot = a.is_bot === true ? "bot" : a.is_bot === false ? "user" : `is_bot=${a.is_bot}`;
      const uid = a.user_id ? `${a.user_id.slice(0, 3)}...` : "no_uid";
      return `${bot}:${uid}`;
    })
    .join(",");
}

export async function resolveSlackSigningSecret(): Promise<string> {
  const env = process.env.SLACK_SIGNING_SECRET?.trim() || "";
  if (env) return env;
  console.warn("slack_events_signing_secret_fallback");
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

type ClaimInsertResult = {
  data: { event_id?: string } | null;
  error: { code?: string } | null;
};

let claimInsertOverride:
  | null
  | ((eventId: string) => Promise<ClaimInsertResult>) = null;

/** Test-only: simulate slack_mention_events insert (production path). */
export function setSlackMentionClaimInsertForTests(
  override: typeof claimInsertOverride
): void {
  claimInsertOverride = override;
}

function claimInProcess(id: string): boolean {
  if (demoClaimedEvents.has(id)) return false;
  demoClaimedEvents.add(id);
  return true;
}

function settleClaimInsert(
  id: string,
  result: ClaimInsertResult
): boolean {
  if (result.error) {
    if (result.error.code === "23505") return false;
    console.error("slack_mention_event_claim_failed", result.error);
    return claimInProcess(id);
  }
  return true;
}

export async function claimSlackMentionEvent(eventId: string): Promise<boolean> {
  const id = eventId.trim();
  if (!id) return false;
  if (claimInsertOverride) {
    return settleClaimInsert(id, await claimInsertOverride(id));
  }
  if (isDemoMode()) return claimInProcess(id);
  const admin = createSupabaseAdminClient();
  if (!admin) return claimInProcess(id);
  const { data, error } = await admin
    .from("slack_mention_events")
    .insert({ event_id: id })
    .select("event_id")
    .maybeSingle();
  return settleClaimInsert(id, { data, error });
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
  channelId: string;
  isDirectMessage: boolean;
  userTokenAuth: SlackAuthorization | null;
}): Promise<SlackMentionTarget[]> {
  if (input.isDirectMessage) {
    let target: SlackMentionTarget | null = null;

    // Try user-token resolver first when authorizations present
    if (input.userTokenAuth) {
      target = await resolveSlackUserTokenImWakeTarget({
        slackChannelId: input.channelId,
        slackTeamId: input.teamId,
        authorizedSlackUserId: input.userTokenAuth.user_id || "",
      });
    }

    // Fall back to Path A resolver when user-token resolver returns null
    // (e.g., Slack puts the speaker in authorizations, not the recipient)
    // or when there is no userTokenAuth at all.
    if (!target) {
      target = await resolveSlackImWakeTarget({
        slackChannelId: input.channelId,
        slackTeamId: input.teamId,
      });
    }

    if (!target) return [];
    // Self-skip: speaker is the bound employee
    if (
      target.slackUserId &&
      target.slackUserId.toUpperCase() === input.speakerId.toUpperCase()
    ) {
      return [];
    }
    return [target];
  }
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
  payload: SlackWakePayload,
  trigger: "mention" | "internal_im" | "user_token_im"
): Promise<void> {
  const action =
    trigger === "user_token_im"
      ? "slack.user_token_im_wake"
      : trigger === "internal_im"
        ? "slack.internal_im_wake"
        : "slack.mention_wake";
  const purpose =
    trigger === "user_token_im" || trigger === "internal_im"
      ? "slack.internal_im"
      : "slack.mention";
  const url = target.wakeWebhookUrl?.trim() || "";
  if (!url) {
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action,
      purpose,
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
        action,
        purpose,
        summary: "起こす webhook の送信に失敗",
        metadata: {
          reason: "wake_failed",
          status: response.status,
          eventId: payload.eventId,
        },
      }).catch(() => undefined);
      return;
    }
    const summary =
      trigger === "user_token_im"
        ? "社内Slack human DM (user token) で社員を起こした"
        : trigger === "internal_im"
          ? "社内Slack 1:1で社員を起こした"
          : "Slackメンションで社員を起こした";
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action,
      purpose,
      summary,
      metadata: {
        reason: "woke",
        channel: payload.channel,
        ts: payload.ts,
        thread_ts: payload.thread_ts,
        eventId: payload.eventId,
        userTokenPath: trigger === "user_token_im",
      },
    }).catch(() => undefined);
  } catch (error) {
    console.error("slack_mention_wake_failed", target.employeeId, error);
    await appendAuditEvent({
      orgId: target.orgId,
      employeeId: target.employeeId,
      credentialId: null,
      action,
      purpose,
      summary: "起こす webhook の送信に失敗",
      metadata: {
        reason: "wake_failed",
        error: error instanceof Error ? error.message : "wake_failed",
        eventId: payload.eventId,
      },
    }).catch(() => undefined);
  }
}

export type SlackEventOutcome = {
  handled: boolean;
  woke: number;
  duplicate?: boolean;
  skipReason?: string;
  userToken?: boolean;
  isDirectMessage?: boolean;
};

export async function processSlackMentionEnvelope(
  envelope: SlackEnvelope
): Promise<SlackEventOutcome> {
  const event = envelope.event;
  const eventId = str(envelope.event_id);
  const eventType = str(event?.type);
  const channel = str(event?.channel);
  const channelType = str(event?.channel_type);
  const userTokenAuth = extractUserTokenAuthorization(envelope);

  if (!event || !eventId) {
    console.warn("slack_event_skip", {
      eventId: eventId || "missing",
      reason: "missing_event_or_id",
    });
    return { handled: false, woke: 0, skipReason: "missing_event_or_id" };
  }

  if (eventType !== "app_mention" && eventType !== "message") {
    console.info("slack_event_skip", {
      eventId,
      eventType,
      reason: "unsupported_event_type",
    });
    return { handled: false, woke: 0, skipReason: "unsupported_event_type" };
  }

  if (shouldIgnoreEvent(event)) {
    const subtype = str(event.subtype);
    const reason = subtype
      ? `ignored_subtype:${subtype}`
      : str(event.bot_id) || event.bot_profile
        ? "bot_message"
        : "ignored_event";
    console.info("slack_event_skip", {
      eventId,
      eventType,
      channel,
      channelType,
      reason,
    });
    return { handled: true, woke: 0, skipReason: reason };
  }

  const claimed = await claimSlackMentionEvent(eventId);
  if (!claimed) {
    console.info("slack_event_skip", {
      eventId,
      eventType,
      channel,
      reason: "duplicate_event",
    });
    return { handled: true, woke: 0, duplicate: true, skipReason: "duplicate_event" };
  }

  const teamId = str(envelope.team_id);
  const speakerId = str(event.user);
  const text = typeof event.text === "string" ? event.text : "";
  const mentionedIds = extractMentionedUserIds(text, event.blocks);

  // Slack may omit channel_type in some edge cases (user-token events, or unexpected payloads).
  // Any message in a D-prefixed channel is treated as IM to avoid silent drops.
  // Fail-closed via route/classification: unclassified or no-route channels still silent.
  const channelLooksLikeIm = isSlackImChannelId(channel);
  const isDirectMessage =
    eventType === "message" &&
    (channelType === "im" || channelLooksLikeIm);

  const targets = await resolveWakeTargets({
    eventType,
    mentionedIds,
    teamId,
    speakerId,
    channelId: channel,
    isDirectMessage,
    userTokenAuth,
  });

  if (!targets.length) {
    const reason = isDirectMessage
      ? "im_no_route_or_self"
      : mentionedIds.length
        ? "mentioned_ids_not_bound"
        : "no_wake_targets";
    console.info("slack_event_skip", {
      eventId,
      eventType,
      channel,
      channelType,
      isDirectMessage,
      channelLooksLikeIm,
      teamId,
      speakerId,
      mentionedCount: mentionedIds.length,
      userToken: Boolean(userTokenAuth),
      authsSummary: summarizeAuthorizations(envelope.authorizations),
      reason,
    });
    return {
      handled: true,
      woke: 0,
      skipReason: reason,
      userToken: Boolean(userTokenAuth),
      isDirectMessage,
    };
  }

  const ts = str(event.ts);
  const threadTs = str(event.thread_ts) || null;
  let woke = 0;
  const trigger: "mention" | "internal_im" | "user_token_im" = isDirectMessage
    ? userTokenAuth
      ? "user_token_im"
      : "internal_im"
    : "mention";

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
    await postWake(target, payload, trigger);
    if (target.wakeWebhookUrl?.trim()) woke += 1;
  }

  console.info("slack_event_wake_complete", {
    eventId,
    eventType,
    channel,
    channelType,
    isDirectMessage,
    channelLooksLikeIm,
    trigger,
    targetCount: targets.length,
    woke,
    skippedNoWebhook: targets.length - woke,
    userToken: Boolean(userTokenAuth),
    authsSummary: summarizeAuthorizations(envelope.authorizations),
  });

  return { handled: true, woke, userToken: Boolean(userTokenAuth), isDirectMessage };
}

export async function acknowledgeSlackEventsRequest(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
}): Promise<{
  status: number;
  body: Record<string, unknown>;
  envelope?: SlackEnvelope;
}> {
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

  return { status: 200, body: { ok: true }, envelope };
}

export async function handleSlackEventsRequest(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await acknowledgeSlackEventsRequest(input);
  if (result.envelope) {
    try {
      await processSlackMentionEnvelope(result.envelope);
    } catch (error) {
      console.error("slack_events_handle_failed", error);
    }
  }
  return { status: result.status, body: result.body };
}
