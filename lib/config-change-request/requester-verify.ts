/**
 * config.change_request — check the requester the AI declares against the real
 * Slack speaker recorded by Staffpass when the AI was woken.
 *
 * Trust model:
 * - requestedBy {name, slackUserId, email} is written by the AI → untrusted.
 * - The "woke" audit (slack.*_wake, metadata.reason = "woke") is written by
 *   Staffpass from a Slack-signed event and records speakerId → trusted.
 * - Verified only when the declared slackUserId exactly equals a speaker of
 *   the same channel (and thread, if given) for THIS org + employee within the
 *   time window. Any lookup failure → unverified (never verified by default).
 *
 * The name itself cannot be proven (no human Slack directory); copy therefore
 * uses the declared name only for verified requests and always shows the
 * Slack user ID to the approver.
 */
import { listRecentWakeAuditsForEmployee } from "@/lib/data/audit";
import type { ConfigChangeConversation, ConfigChangeRequester, RequesterVerification } from "./core";

export const THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CHANNEL_WINDOW_MS = 30 * 60 * 1000;
const SLACK_USER_ID = /^[UW][A-Z0-9_]{2,}$/;

export type WakeRecord = {
  channel: string;
  ts: string | null;
  threadTs: string | null;
  speakerId: string | null;
  createdAt: string;
};

type WakeAuditLike = { metadata?: Record<string, unknown> | null; createdAt: string };

export type RequesterVerifyDeps = {
  /** null = lookup failed. */
  listWakes: (orgId: string, employeeId: string, sinceIso: string) => Promise<WakeAuditLike[] | null>;
};

const DEFAULT_DEPS: RequesterVerifyDeps = {
  listWakes: (orgId, employeeId, sinceIso) => listRecentWakeAuditsForEmployee(orgId, employeeId, sinceIso),
};

const s = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const normId = (value: unknown): string => s(value).toUpperCase();

function result(
  status: RequesterVerification["status"],
  reason: RequesterVerification["reason"],
  declared: string | null,
  observed: string[],
  now: number
): RequesterVerification {
  return {
    status,
    reason,
    declaredSlackUserId: declared,
    observedSpeakerIds: observed,
    checkedAt: new Date(now).toISOString(),
  };
}

export function toWakeRecord(event: WakeAuditLike): WakeRecord | null {
  const meta = event.metadata || {};
  if (meta.reason !== "woke") return null;
  const channel = s(meta.channel);
  if (!channel) return null;
  const speaker = normId(meta.speakerId);
  return {
    channel,
    ts: s(meta.ts) || null,
    threadTs: s(meta.thread_ts) || null,
    speakerId: SLACK_USER_ID.test(speaker) ? speaker : null,
    createdAt: event.createdAt,
  };
}

/** Pure decision; see module comment. */
export function evaluateConfigChangeRequester(input: {
  requestedBy: ConfigChangeRequester;
  conversation: ConfigChangeConversation | null;
  wakes: WakeRecord[];
  now?: number;
}): RequesterVerification {
  const now = input.now ?? Date.now();
  const declaredRaw = normId(input.requestedBy.slackUserId);
  const declared = SLACK_USER_ID.test(declaredRaw) ? declaredRaw : null;
  const conv = input.conversation;
  const surface = s(conv?.surface).toLowerCase();
  if (surface && surface !== "slack") return result("unverified", "surface_not_supported", declared, [], now);
  const channel = s(conv?.slackChannelId);
  if (!conv || !channel) return result("unverified", "no_conversation", declared, [], now);
  const thread = s(conv.threadTs);
  const windowMs = thread ? THREAD_WINDOW_MS : CHANNEL_WINDOW_MS;
  const observed: string[] = [];
  for (const wake of input.wakes) {
    if (!wake.speakerId || wake.channel !== channel) continue;
    const at = Date.parse(wake.createdAt);
    if (!Number.isFinite(at) || at < now - windowMs || at > now + 60_000) continue;
    if (thread && wake.ts !== thread && wake.threadTs !== thread) continue;
    if (!observed.includes(wake.speakerId)) observed.push(wake.speakerId);
  }
  if (!declared) return result("unverified", "no_declared_slack_user", null, observed, now);
  if (observed.length === 0) return result("unverified", "no_wake_record", declared, [], now);
  if (observed.includes(declared)) return result("verified", "speaker_match", declared, observed, now);
  return result("mismatch", "speaker_mismatch", declared, observed, now);
}

export async function verifyConfigChangeRequester(
  input: {
    orgId: string;
    employeeId: string;
    requestedBy: ConfigChangeRequester;
    conversation: ConfigChangeConversation | null;
    now?: number;
  },
  deps: Partial<RequesterVerifyDeps> = {}
): Promise<RequesterVerification> {
  const now = input.now ?? Date.now();
  const d = { ...DEFAULT_DEPS, ...deps };
  const preliminary = evaluateConfigChangeRequester({ ...input, wakes: [], now });
  // Nothing to look up for these; avoid a DB read.
  if (preliminary.reason === "surface_not_supported" || preliminary.reason === "no_conversation") return preliminary;
  let rows: WakeAuditLike[] | null;
  try {
    rows = await d.listWakes(input.orgId, input.employeeId, new Date(now - THREAD_WINDOW_MS).toISOString());
  } catch {
    rows = null;
  }
  if (!rows) {
    return result("unverified", "lookup_failed", preliminary.declaredSlackUserId, [], now);
  }
  const wakes = rows.map(toWakeRecord).filter((row): row is WakeRecord => row !== null);
  return evaluateConfigChangeRequester({ ...input, wakes, now });
}
