/**
 * AI→AI Slack wake allowlist + per-thread cap/stop (八坂 GO 2026-10-16).
 *
 * Tables (migration 20261016100000, not applied to production by this PR):
 *   ai_peer_wake_allowlist  org-scoped A→B pairs (optional channel)
 *   ai_peer_wake_threads    cap counter + human stop per thread / root window
 *
 * Flag OFF → callers must not hit this module (the guard returns before).
 * Fail-closed: a read/write error is never "allowed".
 *
 * Demo uses in-memory maps. Production writes go through service_role only
 * (RLS on, no policy). Tenant isolation is org_id on every query.
 */
import { randomBytes } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getEmployee } from "@/lib/data/employees";
import type { EmployeeSlackIdentity } from "@/lib/types";

export const MEMBER_ACTOR_RE = /^member:[A-Za-z0-9_-]{1,64}$/;
const MEMBER_UUID_ACTOR_RE = /^member:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_RE = /^[CGD][A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[TE][A-Za-z0-9_]{1,32}$/;
const TS_RE = /^[0-9]{9,12}\.[0-9]{1,8}$/;
const STOP_REF_RE = /^[0-9a-f]{16}$/;

export type AiPeerWakeAllowlistRow = {
  id: string;
  orgId: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  slackChannelId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type AiPeerWakeThreadRow = {
  id: string;
  orgId: string;
  slackTeamId: string;
  slackChannelId: string;
  threadTs: string | null;
  windowStart: string | null;
  threadKey: string;
  wakeCount: number;
  cap: number;
  stopRef: string;
  stoppedAt: string | null;
  stoppedBy: string | null;
  cappedNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SpeakerBindLookup =
  | { state: "ok"; rows: Array<{ employeeId: string; orgId: string; slackUserId: string; slackTeamId: string }> }
  | { state: "unavailable" };

export type PairAllowedLookup = { state: "allowed" } | { state: "denied" } | { state: "unavailable" };

export type ClaimPeerWakeResult =
  | { state: "allowed"; count: number; threadId: string; stopRef: string; notify: boolean }
  | { state: "capped"; count: number; threadId: string; stopRef: string; notify: boolean }
  | { state: "stopped"; count: number; threadId: string; stopRef: string; notify: false }
  | { state: "denied" }
  | { state: "unavailable" };

export type StopPeerWakeResult =
  | { state: "stopped"; thread: AiPeerWakeThreadRow }
  | { state: "already_stopped"; thread: AiPeerWakeThreadRow }
  | { state: "not_found" }
  | { state: "denied"; reason: string }
  | { state: "unavailable" };

export type ResumePeerWakeResult =
  | { state: "resumed"; thread: AiPeerWakeThreadRow }
  | { state: "not_stopped"; thread: AiPeerWakeThreadRow }
  | { state: "not_found" }
  | { state: "denied"; reason: string }
  | { state: "unavailable" };

type DemoAllow = AiPeerWakeAllowlistRow;
type DemoThread = AiPeerWakeThreadRow;

const demoAllow = new Map<string, DemoAllow>();
const demoThreads = new Map<string, DemoThread>();

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function newStopRef(): string {
  return randomBytes(8).toString("hex");
}

export function isMemberActor(value: string): boolean {
  return MEMBER_ACTOR_RE.test(value.trim());
}

export function threadKeyFor(input: { threadTs: string | null; eventTs: string; windowSeconds: number }): string | null {
  if (input.threadTs) {
    return TS_RE.test(input.threadTs) ? input.threadTs : null;
  }
  if (!TS_RE.test(input.eventTs)) return null;
  const epoch = Number.parseInt(input.eventTs.split(".")[0] || "", 10);
  if (!Number.isFinite(epoch) || input.windowSeconds < 1) return null;
  const start = Math.floor(epoch / input.windowSeconds) * input.windowSeconds;
  return `w:${start}`;
}

function windowStartIso(threadKey: string): string | null {
  if (!threadKey.startsWith("w:")) return null;
  const epoch = Number.parseInt(threadKey.slice(2), 10);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000).toISOString();
}

function mapAllowRow(row: Record<string, unknown>): AiPeerWakeAllowlistRow {
  const channel = String(row.slack_channel_id ?? row.slackChannelId ?? "").trim();
  return {
    id: String(row.id ?? ""),
    orgId: String(row.org_id ?? row.orgId ?? ""),
    fromEmployeeId: String(row.from_employee_id ?? row.fromEmployeeId ?? ""),
    toEmployeeId: String(row.to_employee_id ?? row.toEmployeeId ?? ""),
    slackChannelId: channel || null,
    enabled: Boolean(row.enabled ?? true),
    createdBy: String(row.created_by ?? row.createdBy ?? ""),
    createdAt: String(row.created_at ?? row.createdAt ?? nowIso()),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function mapThreadRow(row: Record<string, unknown>): AiPeerWakeThreadRow {
  const threadTs = String(row.thread_ts ?? row.threadTs ?? "").trim();
  const windowStart = String(row.window_start ?? row.windowStart ?? "").trim();
  const stoppedAt = String(row.stopped_at ?? row.stoppedAt ?? "").trim();
  const stoppedBy = String(row.stopped_by ?? row.stoppedBy ?? "").trim();
  const capped = String(row.capped_notified_at ?? row.cappedNotifiedAt ?? "").trim();
  return {
    id: String(row.id ?? ""),
    orgId: String(row.org_id ?? row.orgId ?? ""),
    slackTeamId: String(row.slack_team_id ?? row.slackTeamId ?? ""),
    slackChannelId: String(row.slack_channel_id ?? row.slackChannelId ?? ""),
    threadTs: threadTs || null,
    windowStart: windowStart || null,
    threadKey: String(row.thread_key ?? row.threadKey ?? ""),
    wakeCount: Number(row.wake_count ?? row.wakeCount ?? 0),
    cap: Number(row.cap ?? 4),
    stopRef: String(row.stop_ref ?? row.stopRef ?? ""),
    stoppedAt: stoppedAt || null,
    stoppedBy: stoppedBy || null,
    cappedNotifiedAt: capped || null,
    createdAt: String(row.created_at ?? row.createdAt ?? nowIso()),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function identityPublic(row: Record<string, unknown>): EmployeeSlackIdentity {
  const statusRaw = String(row.status || "linked");
  const status =
    statusRaw === "linked" || statusRaw === "needs_reauth" || statusRaw === "revoked"
      ? statusRaw
      : "linked";
  return {
    employeeId: String(row.employee_id ?? row.employeeId ?? ""),
    orgId: String(row.org_id ?? row.orgId ?? ""),
    slackUserId: String(row.slack_user_id ?? row.slackUserId ?? ""),
    slackTeamId: String(row.slack_team_id ?? row.slackTeamId ?? ""),
    displayName: String(row.display_name ?? row.displayName ?? ""),
    status,
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

/**
 * Team-scoped linked-identity lookup that distinguishes empty from unreadable.
 * getEmployeesBySlackUserIds returns [] on error — that would fail *open* here.
 */
export async function lookupSpeakerBindings(input: {
  slackUserId: string;
  teamId: string;
}): Promise<SpeakerBindLookup> {
  const slackUserId = input.slackUserId.trim();
  const teamId = input.teamId.trim();
  if (!slackUserId || !teamId) return { state: "ok", rows: [] };
  if (isDemoMode()) {
    const { getEmployeesBySlackUserIds } = await import("@/lib/data/slack-identities");
    const rows = await getEmployeesBySlackUserIds([slackUserId], teamId);
    return {
      state: "ok",
      rows: rows.map((r) => ({
        employeeId: r.employeeId,
        orgId: r.orgId,
        slackUserId: r.slackUserId,
        slackTeamId: r.slackTeamId,
      })),
    };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const userVariants = [...new Set([slackUserId, slackUserId.toUpperCase(), slackUserId.toLowerCase()])];
  const teamVariants = [...new Set([teamId, teamId.toUpperCase(), teamId.toLowerCase()])];
  const { data, error } = await admin
    .from("employee_slack_identities")
    .select("employee_id,org_id,slack_user_id,slack_team_id,status")
    .in("slack_user_id", userVariants)
    .in("slack_team_id", teamVariants)
    .eq("status", "linked");
  if (error) return { state: "unavailable" };
  const wantedUser = slackUserId.toUpperCase();
  const wantedTeam = teamId.toUpperCase();
  const rows = (data ?? [])
    .map((row) => identityPublic(row as Record<string, unknown>))
    .filter(
      (row) =>
        row.status === "linked" &&
        row.slackUserId.toUpperCase() === wantedUser &&
        row.slackTeamId.toUpperCase() === wantedTeam
    )
    .map((row) => ({
      employeeId: row.employeeId,
      orgId: row.orgId,
      slackUserId: row.slackUserId,
      slackTeamId: row.slackTeamId,
    }));
  return { state: "ok", rows };
}

/** Any-org linked identity for a Slack user (AI-cannot-stop check). */
export async function findLinkedIdentitiesBySlackUserId(
  slackUserId: string
): Promise<{ state: "ok"; rows: EmployeeSlackIdentity[] } | { state: "unavailable" }> {
  const id = slackUserId.trim();
  if (!id) return { state: "ok", rows: [] };
  if (isDemoMode()) {
    const { listLinkedSlackIdentitiesForOrg } = await import("@/lib/data/slack-identities");
    const { getRuntimeEmployees } = await import("@/lib/demo-data");
    const orgs = [...new Set(getRuntimeEmployees().map((e) => e.orgId))];
    const rows: EmployeeSlackIdentity[] = [];
    for (const orgId of orgs) {
      const found = await listLinkedSlackIdentitiesForOrg(orgId);
      for (const row of found) {
        if (row.slackUserId.toUpperCase() === id.toUpperCase()) rows.push(row);
      }
    }
    return { state: "ok", rows };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const variants = [...new Set([id, id.toUpperCase(), id.toLowerCase()])];
  const { data, error } = await admin
    .from("employee_slack_identities")
    .select("employee_id,org_id,slack_user_id,slack_team_id,display_name,status,updated_at")
    .in("slack_user_id", variants)
    .eq("status", "linked");
  if (error) return { state: "unavailable" };
  const wanted = id.toUpperCase();
  return {
    state: "ok",
    rows: (data ?? [])
      .map((row) => identityPublic(row as Record<string, unknown>))
      .filter((row) => row.status === "linked" && row.slackUserId.toUpperCase() === wanted),
  };
}

export async function isPairAllowed(input: {
  orgId: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  slackChannelId: string;
}): Promise<PairAllowedLookup> {
  const orgId = input.orgId.trim();
  const fromEmployeeId = input.fromEmployeeId.trim();
  const toEmployeeId = input.toEmployeeId.trim();
  const slackChannelId = input.slackChannelId.trim();
  if (!orgId || !fromEmployeeId || !toEmployeeId || fromEmployeeId === toEmployeeId) {
    return { state: "denied" };
  }
  if (isDemoMode()) {
    const matches = [...demoAllow.values()].filter(
      (row) =>
        row.enabled &&
        row.orgId === orgId &&
        row.fromEmployeeId === fromEmployeeId &&
        row.toEmployeeId === toEmployeeId &&
        (row.slackChannelId === null || row.slackChannelId.toUpperCase() === slackChannelId.toUpperCase())
    );
    return { state: matches.length ? "allowed" : "denied" };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin
    .from("ai_peer_wake_allowlist")
    .select("id,org_id,from_employee_id,to_employee_id,slack_channel_id,enabled")
    .eq("org_id", orgId)
    .eq("from_employee_id", fromEmployeeId)
    .eq("to_employee_id", toEmployeeId)
    .eq("enabled", true);
  if (error) return { state: "unavailable" };
  const wanted = slackChannelId.toUpperCase();
  const ok = (data ?? []).some((raw) => {
    const row = mapAllowRow(raw as Record<string, unknown>);
    return row.orgId === orgId && (!row.slackChannelId || row.slackChannelId.toUpperCase() === wanted);
  });
  return { state: ok ? "allowed" : "denied" };
}

export async function listAllowlist(orgId: string): Promise<AiPeerWakeAllowlistRow[]> {
  const org = orgId.trim();
  if (!org) return [];
  if (isDemoMode()) {
    return [...demoAllow.values()].filter((row) => row.orgId === org);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("ai_peer_wake_allowlist")
    .select("*")
    .eq("org_id", org)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((row) => mapAllowRow(row as Record<string, unknown>)).filter((row) => row.orgId === org);
}

export async function upsertAllowlist(input: {
  orgId: string;
  fromEmployeeId: string;
  toEmployeeId: string;
  slackChannelId?: string | null;
  createdBy: string;
  enabled?: boolean;
}): Promise<AiPeerWakeAllowlistRow> {
  const orgId = input.orgId.trim();
  const fromEmployeeId = input.fromEmployeeId.trim();
  const toEmployeeId = input.toEmployeeId.trim();
  const slackChannelId = (input.slackChannelId || "").trim() || null;
  const createdBy = input.createdBy.trim();
  if (!orgId || !fromEmployeeId || !toEmployeeId) throw new Error("invalid_allowlist");
  if (fromEmployeeId === toEmployeeId) throw new Error("self_pair");
  if (slackChannelId && !CHANNEL_RE.test(slackChannelId)) throw new Error("invalid_channel");
  if (!isMemberActor(createdBy)) throw new Error("actor_not_member");
  const from = await getEmployee(fromEmployeeId, orgId);
  const to = await getEmployee(toEmployeeId, orgId);
  if (!from || !to || from.orgId !== orgId || to.orgId !== orgId) throw new Error("employee_not_found");

  const timestamp = nowIso();
  if (isDemoMode()) {
    const key = `${orgId}:${fromEmployeeId}:${toEmployeeId}:${(slackChannelId || "").toUpperCase()}`;
    const existing = [...demoAllow.values()].find(
      (row) =>
        row.orgId === orgId &&
        row.fromEmployeeId === fromEmployeeId &&
        row.toEmployeeId === toEmployeeId &&
        (row.slackChannelId || "").toUpperCase() === (slackChannelId || "").toUpperCase()
    );
    const row: DemoAllow = {
      id: existing?.id ?? newId("apw"),
      orgId,
      fromEmployeeId,
      toEmployeeId,
      slackChannelId,
      enabled: input.enabled ?? true,
      createdBy: existing?.createdBy ?? createdBy,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    demoAllow.set(key, row);
    return row;
  }
  if (!MEMBER_UUID_ACTOR_RE.test(createdBy)) throw new Error("actor_not_member");
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("ai_peer_wake_allowlist")
    .upsert(
      {
        org_id: orgId,
        from_employee_id: fromEmployeeId,
        to_employee_id: toEmployeeId,
        slack_channel_id: slackChannelId ?? "",
        enabled: input.enabled ?? true,
        created_by: createdBy,
        updated_at: timestamp,
      },
      { onConflict: "org_id,from_employee_id,to_employee_id,slack_channel_id" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "allowlist_upsert_failed");
  return mapAllowRow(data as Record<string, unknown>);
}

export async function deleteAllowlist(input: { orgId: string; id: string }): Promise<boolean> {
  const orgId = input.orgId.trim();
  const id = input.id.trim();
  if (!orgId || !id) return false;
  if (isDemoMode()) {
    for (const [key, row] of demoAllow.entries()) {
      if (row.id === id && row.orgId === orgId) {
        demoAllow.delete(key);
        return true;
      }
    }
    return false;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin
    .from("ai_peer_wake_allowlist")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();
  return !error && Boolean(data);
}

function demoThreadStoreKey(orgId: string, channelId: string, threadKey: string): string {
  return `${orgId}:${channelId.toUpperCase()}:${threadKey}`;
}

export async function claimPeerWake(input: {
  orgId: string;
  teamId: string;
  channelId: string;
  threadTs: string | null;
  eventTs: string;
  cap: number;
  windowSeconds: number;
}): Promise<ClaimPeerWakeResult> {
  const orgId = input.orgId.trim();
  const teamId = input.teamId.trim();
  const channelId = input.channelId.trim();
  const threadTs = (input.threadTs || "").trim() || null;
  const eventTs = input.eventTs.trim();
  const cap = input.cap;
  const windowSeconds = input.windowSeconds;
  const threadKey = threadKeyFor({ threadTs, eventTs, windowSeconds });
  if (!orgId || !TEAM_RE.test(teamId) || !CHANNEL_RE.test(channelId) || !TS_RE.test(eventTs) || !threadKey) {
    return { state: "denied" };
  }
  if (cap < 1 || cap > 20 || windowSeconds < 60 || windowSeconds > 86_400) return { state: "denied" };

  if (isDemoMode()) {
    const key = demoThreadStoreKey(orgId, channelId, threadKey);
    let row = demoThreads.get(key);
    if (!row) {
      row = {
        id: newId("apwt"),
        orgId,
        slackTeamId: teamId,
        slackChannelId: channelId,
        threadTs,
        windowStart: threadTs ? null : windowStartIso(threadKey),
        threadKey,
        wakeCount: 1,
        cap,
        stopRef: newStopRef(),
        stoppedAt: null,
        stoppedBy: null,
        cappedNotifiedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      demoThreads.set(key, row);
      return { state: "allowed", count: 1, threadId: row.id, stopRef: row.stopRef, notify: false };
    }
    if (row.orgId !== orgId) return { state: "denied" };
    if (row.stoppedAt) {
      return { state: "stopped", count: row.wakeCount, threadId: row.id, stopRef: row.stopRef, notify: false };
    }
    if (row.wakeCount >= row.cap) {
      const notify = !row.cappedNotifiedAt;
      if (notify) {
        row = { ...row, cappedNotifiedAt: nowIso(), updatedAt: nowIso() };
        demoThreads.set(key, row);
      }
      return { state: "capped", count: row.wakeCount, threadId: row.id, stopRef: row.stopRef, notify };
    }
    row = { ...row, wakeCount: row.wakeCount + 1, cap, slackTeamId: teamId, updatedAt: nowIso() };
    demoThreads.set(key, row);
    return { state: "allowed", count: row.wakeCount, threadId: row.id, stopRef: row.stopRef, notify: false };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin.rpc("claim_ai_peer_wake", {
    p_org: orgId,
    p_team: teamId,
    p_channel: channelId,
    p_thread_ts: threadTs,
    p_event_ts: eventTs,
    p_cap: cap,
    p_window_seconds: windowSeconds,
  });
  if (error || data == null) return { state: "unavailable" };
  const rec = data as Record<string, unknown>;
  const state = String(rec.state || "");
  const count = Number(rec.count ?? 0);
  const threadId = String(rec.threadId ?? rec.thread_id ?? "");
  const stopRef = String(rec.stopRef ?? rec.stop_ref ?? "");
  const notify = rec.notify === true;
  if (state === "allowed" && threadId && STOP_REF_RE.test(stopRef)) {
    return { state: "allowed", count, threadId, stopRef, notify };
  }
  if (state === "capped" && threadId && STOP_REF_RE.test(stopRef)) {
    return { state: "capped", count, threadId, stopRef, notify };
  }
  if (state === "stopped" && threadId && STOP_REF_RE.test(stopRef)) {
    return { state: "stopped", count, threadId, stopRef, notify: false };
  }
  if (state === "denied") return { state: "denied" };
  return { state: "unavailable" };
}

export async function getThreadByStopRef(input: {
  orgId: string;
  stopRef: string;
}): Promise<{ state: "ok"; thread: AiPeerWakeThreadRow } | { state: "not_found" } | { state: "unavailable" }> {
  const orgId = input.orgId.trim();
  const stopRef = input.stopRef.trim().toLowerCase();
  if (!orgId || !STOP_REF_RE.test(stopRef)) return { state: "not_found" };
  if (isDemoMode()) {
    const thread = [...demoThreads.values()].find((row) => row.orgId === orgId && row.stopRef === stopRef);
    return thread ? { state: "ok", thread } : { state: "not_found" };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin
    .from("ai_peer_wake_threads")
    .select("*")
    .eq("org_id", orgId)
    .eq("stop_ref", stopRef)
    .maybeSingle();
  if (error) return { state: "unavailable" };
  if (!data) return { state: "not_found" };
  const thread = mapThreadRow(data as Record<string, unknown>);
  return thread.orgId === orgId ? { state: "ok", thread } : { state: "not_found" };
}

export async function getThreadById(input: {
  orgId: string;
  id: string;
}): Promise<{ state: "ok"; thread: AiPeerWakeThreadRow } | { state: "not_found" } | { state: "unavailable" }> {
  const orgId = input.orgId.trim();
  const id = input.id.trim();
  if (!orgId || !id) return { state: "not_found" };
  if (isDemoMode()) {
    const thread = [...demoThreads.values()].find((row) => row.orgId === orgId && row.id === id);
    return thread ? { state: "ok", thread } : { state: "not_found" };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin
    .from("ai_peer_wake_threads")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: "unavailable" };
  if (!data) return { state: "not_found" };
  const thread = mapThreadRow(data as Record<string, unknown>);
  return thread.orgId === orgId ? { state: "ok", thread } : { state: "not_found" };
}

export async function listThreads(orgId: string): Promise<AiPeerWakeThreadRow[]> {
  const org = orgId.trim();
  if (!org) return [];
  if (isDemoMode()) {
    return [...demoThreads.values()]
      .filter((row) => row.orgId === org)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("ai_peer_wake_threads")
    .select("*")
    .eq("org_id", org)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return data.map((row) => mapThreadRow(row as Record<string, unknown>)).filter((row) => row.orgId === org);
}

export async function stopPeerWakeThread(input: {
  orgId: string;
  stopRef?: string;
  id?: string;
  stoppedBy: string;
}): Promise<StopPeerWakeResult> {
  const orgId = input.orgId.trim();
  const stoppedBy = input.stoppedBy.trim();
  if (!orgId) return { state: "denied", reason: "invalid" };
  if (!isMemberActor(stoppedBy)) return { state: "denied", reason: "actor_not_member" };

  const found = input.stopRef
    ? await getThreadByStopRef({ orgId, stopRef: input.stopRef })
    : input.id
      ? await getThreadById({ orgId, id: input.id })
      : { state: "not_found" as const };
  if (found.state === "unavailable") return { state: "unavailable" };
  if (found.state === "not_found") return { state: "not_found" };
  const thread = found.thread;
  if (thread.orgId !== orgId) return { state: "not_found" };
  if (thread.stoppedAt) return { state: "already_stopped", thread };

  if (isDemoMode()) {
    const key = demoThreadStoreKey(thread.orgId, thread.slackChannelId, thread.threadKey);
    const next: DemoThread = { ...thread, stoppedAt: nowIso(), stoppedBy, updatedAt: nowIso() };
    demoThreads.set(key, next);
    return { state: "stopped", thread: next };
  }
  if (!MEMBER_UUID_ACTOR_RE.test(stoppedBy)) return { state: "denied", reason: "actor_not_member" };
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin.rpc("stop_ai_peer_wake_thread", {
    p_org: orgId,
    p_id: thread.id,
    p_stopped_by: stoppedBy,
  });
  if (error || data == null) return { state: "unavailable" };
  const rec = data as Record<string, unknown>;
  const state = String(rec.state || "");
  if (state === "stopped" || state === "already_stopped") {
    const row = rec.thread && typeof rec.thread === "object"
      ? mapThreadRow(rec.thread as Record<string, unknown>)
      : (await getThreadById({ orgId, id: thread.id }));
    const resolved = "state" in (row as object) && (row as { state: string }).state
      ? (row as { state: string; thread?: AiPeerWakeThreadRow }).thread
      : (row as AiPeerWakeThreadRow);
    if (!resolved) return { state: "unavailable" };
    return { state, thread: resolved };
  }
  if (state === "not_found") return { state: "not_found" };
  if (state === "denied") return { state: "denied", reason: String(rec.reason || "denied") };
  return { state: "unavailable" };
}

export async function resumePeerWakeThread(input: {
  orgId: string;
  id: string;
  resumedBy: string;
}): Promise<ResumePeerWakeResult> {
  const orgId = input.orgId.trim();
  const id = input.id.trim();
  const resumedBy = input.resumedBy.trim();
  if (!orgId || !id) return { state: "denied", reason: "invalid" };
  if (!isMemberActor(resumedBy)) return { state: "denied", reason: "actor_not_member" };

  const found = await getThreadById({ orgId, id });
  if (found.state === "unavailable") return { state: "unavailable" };
  if (found.state === "not_found") return { state: "not_found" };
  if (found.thread.orgId !== orgId) return { state: "not_found" };

  if (isDemoMode()) {
    const thread = found.thread;
    const key = demoThreadStoreKey(thread.orgId, thread.slackChannelId, thread.threadKey);
    const next: DemoThread = {
      ...thread,
      stoppedAt: null,
      stoppedBy: null,
      wakeCount: 0,
      cappedNotifiedAt: null,
      updatedAt: nowIso(),
    };
    demoThreads.set(key, next);
    return thread.stoppedAt ? { state: "resumed", thread: next } : { state: "not_stopped", thread: next };
  }
  if (!MEMBER_UUID_ACTOR_RE.test(resumedBy)) return { state: "denied", reason: "actor_not_member" };
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  const { data, error } = await admin.rpc("resume_ai_peer_wake_thread", {
    p_org: orgId,
    p_id: id,
    p_resumed_by: resumedBy,
  });
  if (error || data == null) return { state: "unavailable" };
  const rec = data as Record<string, unknown>;
  const state = String(rec.state || "");
  const row = rec.thread && typeof rec.thread === "object"
    ? mapThreadRow(rec.thread as Record<string, unknown>)
    : (await getThreadById({ orgId, id }));
  const resolved = "state" in (row as object) && (row as { state?: string }).state
    ? (row as { thread?: AiPeerWakeThreadRow }).thread
    : (row as AiPeerWakeThreadRow);
  if (state === "resumed" && resolved) return { state: "resumed", thread: resolved };
  if (state === "not_stopped" && resolved) return { state: "not_stopped", thread: resolved };
  if (state === "not_found") return { state: "not_found" };
  if (state === "denied") return { state: "denied", reason: String(rec.reason || "denied") };
  return { state: "unavailable" };
}

/** Tests / demo only. */
export function resetDemoAiPeerWake(): void {
  demoAllow.clear();
  demoThreads.clear();
}
