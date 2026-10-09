/**
 * Path C re-wake store (PATHC_REWAKE_ON_CLASSIFY_ENABLED, migration
 * 20261009700000_slack_skipped_channel_wakes). One row per org × employee ×
 * channel: the LATEST user-token channel mention that was not woken because
 * the channel was unclassified. Ids and timestamps only — never message text,
 * tokens or names.
 *
 * - recordSkippedChannelWake: upsert; an older (out-of-order) event never
 *   replaces a newer one (claimed or not); a newer skip replaces and reopens it.
 * - claimSkippedChannelWakes: ONE atomic statement (UPDATE … WHERE
 *   claimed_at IS NULL … RETURNING) scoped to the approval's org, and only
 *   when that approval is an approved ticket of the same org. Concurrent
 *   claims → exactly one winner per row.
 *
 * service_role RPCs only (anon / authenticated: no table access, no EXECUTE).
 * Store errors → "unavailable" (callers then do nothing: no wake is better
 * than a possible double wake).
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const SKIPPED_WAKE_TTL_SECONDS = 24 * 60 * 60;

const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;
const USER_RE = /^[UWB][A-Z0-9]{2,31}$/;
const TEAM_RE = /^[TE][A-Z0-9]{2,31}$/;
const TS_RE = /^[0-9]{9,11}\.[0-9]{1,8}$/;
const EVENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type SkippedChannelWakeInput = {
  orgId: string;
  employeeId: string;
  channelId: string;
  eventTs: string;
  threadTs: string | null;
  eventId: string;
  speakerSlackUserId: string;
  speakerTeamId: string | null;
  subscriberSlackUserId: string;
  subscriberTeamId: string;
  /** Tests only (demo store). */
  nowMs?: number;
};

export type SkippedChannelWake = Omit<SkippedChannelWakeInput, "nowMs"> & {
  skippedAt: string;
  claimedAt: string | null;
  claimedApprovalId: string | null;
};

export type RecordResult = { state: "recorded" | "kept" | "denied" | "unavailable" };
export type ClaimResult = { state: "ok"; rows: SkippedChannelWake[] } | { state: "denied" } | { state: "unavailable" };

function valid(input: SkippedChannelWakeInput): boolean {
  return (
    ID_RE.test(input.orgId || "") &&
    ID_RE.test(input.employeeId || "") &&
    CHANNEL_RE.test(input.channelId || "") &&
    TS_RE.test(input.eventTs || "") &&
    (input.threadTs === null || TS_RE.test(input.threadTs)) &&
    EVENT_RE.test(input.eventId || "") &&
    USER_RE.test(input.speakerSlackUserId || "") &&
    (input.speakerTeamId === null || TEAM_RE.test(input.speakerTeamId)) &&
    USER_RE.test(input.subscriberSlackUserId || "") &&
    TEAM_RE.test(input.subscriberTeamId || "")
  );
}

type DemoRow = SkippedChannelWake & { skippedAtMs: number };
const demoRows = new Map<string, DemoRow>();

export function resetDemoSkippedChannelWakes(): void {
  demoRows.clear();
}

export function listDemoSkippedChannelWakesForTests(): SkippedChannelWake[] {
  return [...demoRows.values()].map(publicRow);
}

function publicRow(row: DemoRow): SkippedChannelWake {
  const copy: Partial<DemoRow> = { ...row };
  delete copy.skippedAtMs;
  return copy as SkippedChannelWake;
}

function tsNum(ts: string): number {
  return Number(ts);
}

export async function recordSkippedChannelWake(input: SkippedChannelWakeInput): Promise<RecordResult> {
  if (!valid(input)) return { state: "denied" };
  if (isDemoMode()) {
    const key = `${input.orgId}\u0000${input.employeeId}\u0000${input.channelId}`;
    const existing = demoRows.get(key);
    if (existing && tsNum(existing.eventTs) >= tsNum(input.eventTs)) return { state: "kept" };
    const nowMs = input.nowMs ?? Date.now();
    const rest: Partial<SkippedChannelWakeInput> = { ...input };
    delete rest.nowMs;
    demoRows.set(key, { ...(rest as Omit<SkippedChannelWakeInput, "nowMs">), skippedAt: new Date(nowMs).toISOString(), skippedAtMs: nowMs, claimedAt: null, claimedApprovalId: null });
    return { state: "recorded" };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  try {
    const { data, error } = await admin.rpc("record_slack_skipped_channel_wake", {
      p_org: input.orgId,
      p_employee: input.employeeId,
      p_channel: input.channelId,
      p_event_ts: input.eventTs,
      p_thread_ts: input.threadTs,
      p_event_id: input.eventId,
      p_speaker: input.speakerSlackUserId,
      p_speaker_team: input.speakerTeamId,
      p_subscriber: input.subscriberSlackUserId,
      p_subscriber_team: input.subscriberTeamId,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable" };
    const state = (data as Record<string, unknown>).state;
    return state === "recorded" || state === "kept" || state === "denied" ? { state } : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

function rowFromDb(raw: Record<string, unknown>): SkippedChannelWake | null {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const row: SkippedChannelWake = {
    orgId: s(raw.org_id) ?? "",
    employeeId: s(raw.employee_id) ?? "",
    channelId: s(raw.channel_id) ?? "",
    eventTs: s(raw.event_ts) ?? "",
    threadTs: s(raw.thread_ts),
    eventId: s(raw.event_id) ?? "",
    speakerSlackUserId: s(raw.speaker_slack_user_id) ?? "",
    speakerTeamId: s(raw.speaker_team_id),
    subscriberSlackUserId: s(raw.subscriber_slack_user_id) ?? "",
    subscriberTeamId: s(raw.subscriber_team_id) ?? "",
    skippedAt: s(raw.skipped_at) ?? "",
    claimedAt: s(raw.claimed_at),
    claimedApprovalId: s(raw.claimed_approval_id),
  };
  return valid(row) ? row : null;
}

/**
 * Claim every unclaimed, in-window row of (org, channel) for one approval.
 * Demo: the approval is re-read from the store and must be approved and of the
 * same org (the RPC checks the same against approval_requests).
 */
export async function claimSkippedChannelWakes(input: {
  orgId: string;
  channelId: string;
  approvalId: string;
  ttlSeconds: number;
  nowMs?: number;
}): Promise<ClaimResult> {
  const ttl = Math.floor(input.ttlSeconds);
  if (!ID_RE.test(input.orgId || "") || !CHANNEL_RE.test(input.channelId || "") || !ID_RE.test(input.approvalId || "") || !(ttl >= 60 && ttl <= 604_800)) {
    return { state: "denied" };
  }
  if (isDemoMode()) {
    const { getApprovalById } = await import("@/lib/data/approvals");
    const approval = await getApprovalById(input.approvalId, input.orgId).catch(() => null);
    if (!approval || approval.orgId !== input.orgId || approval.status !== "approved") return { state: "denied" };
    // Synchronous check-and-set after the await: no interleaving in one JS thread.
    const nowMs = input.nowMs ?? Date.now();
    const rows: SkippedChannelWake[] = [];
    for (const row of demoRows.values()) {
      if (row.orgId !== input.orgId || row.channelId !== input.channelId || row.claimedAt !== null) continue;
      if (nowMs - row.skippedAtMs > ttl * 1000) continue;
      row.claimedAt = new Date(nowMs).toISOString();
      row.claimedApprovalId = input.approvalId;
      rows.push(publicRow(row));
    }
    return { state: "ok", rows };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  try {
    const { data, error } = await admin.rpc("claim_slack_skipped_channel_wakes", {
      p_org: input.orgId,
      p_channel: input.channelId,
      p_approval: input.approvalId,
      p_ttl_seconds: ttl,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable" };
    const result = data as Record<string, unknown>;
    if (result.state === "denied") return { state: "denied" };
    if (result.state !== "ok" || !Array.isArray(result.rows)) return { state: "unavailable" };
    const rows = (result.rows as Array<Record<string, unknown>>)
      .map(rowFromDb)
      .filter((row): row is SkippedChannelWake => row !== null && row.orgId === input.orgId && row.channelId === input.channelId);
    return { state: "ok", rows };
  } catch {
    return { state: "unavailable" };
  }
}
