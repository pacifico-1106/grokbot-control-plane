/**
 * MCP endpoint handoff — the ONE shared, channel-independent place that
 *
 *  1. builds the secret-free, machine-readable `mcpHandoff` block (endpoint from
 *     the app base URL config, connection steps, connectivity-check tool), used by
 *     employees.issue / link results and by every agent wake (Slack user-token
 *     channel / user-token IM / bot mention / internal IM, and approval.resolved
 *     callbacks + machine e-mail from Slack / LINE / Telegram / Web / proxy);
 *  2. records the "bot actually reached Staffpass MCP" signal (`mcp.client_seen`);
 *  3. detects "woken but never connected" and tells a human the next step through
 *     the org's configured notification mouth (Slack / LINE / Telegram alike).
 *
 * Channel code only passes its surface name. Flag: MCP_ENDPOINT_HANDOFF_ENABLED
 * (default OFF → every function here is a no-op / identity).
 *
 * Fail-safe: when in doubt, do NOT notify. Never re-wakes the bot (no loops).
 * Never includes secrets (badge, wake secret, status tokens, signed URLs, tokens).
 */
import {
  SURFACE_LABEL_JA,
  buildMcpHandoff,
  isMcpHandoffSurface,
  resolveMcpEndpointUrl,
  type McpConnectionStatus,
  type McpHandoff,
  type McpHandoffKind,
  type McpHandoffSurface,
} from "@/lib/mcp/endpoint-handoff-block";
import {
  appendAuditEvent,
  listAuditEventsByActionSince,
  listAuditEventsForStuckWatch,
  listEmployeeAuditEvents,
} from "@/lib/data/audit";
import { isMcpEndpointHandoffEnabled } from "@/lib/feature-flags";
import type { AuditEvent } from "@/lib/types";

export {
  MCP_ENDPOINT_PATH,
  MCP_HANDOFF_SCHEMA,
  buildMcpHandoff,
  isMcpHandoffSurface,
  parseMcpHandoff,
  resolveMcpEndpointUrl,
} from "@/lib/mcp/endpoint-handoff-block";
export type {
  McpConnectionStatus,
  McpHandoff,
  McpHandoffKind,
  McpHandoffSurface,
} from "@/lib/mcp/endpoint-handoff-block";


/** Wake must be at least this old before "not connected" is considered. */
export const MCP_NOT_CONNECTED_MIN_MS = 10 * 60_000;
/** Wakes older than this are ignored (no noise from history). */
export const MCP_NOT_CONNECTED_MAX_WAKE_AGE_MS = 24 * 60 * 60_000;
/** One next-step notice per employee per this window. */
export const MCP_NOT_CONNECTED_COOLDOWN_MS = 24 * 60 * 60_000;
/** `mcp.client_seen` write throttle per credential (per instance). */
export const MCP_CLIENT_SEEN_THROTTLE_MS = 10 * 60_000;
/**
 * Activity is searched from (wake - this). Must exceed the seen throttle so a
 * throttled call right after the wake is still covered by the previous seen row.
 */
export const MCP_ACTIVITY_LOOKBEHIND_MS = 15 * 60_000;
const STATE_TIMEOUT_MS = 1_500;

type Env = Record<string, string | undefined>;
const WATCH_AUDIT_LIMIT = 500;

export const MCP_CLIENT_SEEN_ACTION = "mcp.client_seen" as const;
export const MCP_NOT_CONNECTED_NOTIFY_ACTION = "mcp_handoff.not_connected_notify" as const;
export const APPROVAL_WAKE_ACTION = "agent.approval_wake" as const;

/** Every agent-facing wake audit action (all channels). */
export const MCP_HANDOFF_WAKE_ACTIONS = [
  "slack.mention_wake",
  "slack.internal_im_wake",
  "slack.user_token_im_wake",
  "slack.user_token_channel_wake",
  APPROVAL_WAKE_ACTION,
] as const;


export type McpWakeContext = {
  orgId: string;
  employeeId: string;
  surface: McpHandoffSurface;
  kind: McpHandoffKind;
  trigger: string;
};

/** STUB (TDD): wake body that went through withMcpHandoff. */
export type McpHandoffWakeBody<T extends object> = T & { mcpHandoff?: McpHandoff };

/** STUB (TDD): stage-1 "reconnect prompt armed" audit (no human notice yet). */
export const MCP_RECONNECT_ARMED_ACTION = "mcp_handoff.reconnect_armed" as const;
/** STUB (TDD): fallback escalation when no follow-up wake arrives after arming. */
export const MCP_RECONNECT_ESCALATE_MS = 60 * 60_000;

export type NotConnectedNotice = {
  headline: string;
  action: string;
  copyLine: string;
  footer: string;
};
export type NoticeFormat = "slack" | "telegram" | "line" | "plain";

/** STUB (TDD) */
export function buildNotConnectedNotice(input: {
  employeeId: string;
  displayName?: string | null;
  surface: McpHandoffSurface;
  minutesSinceWake: number;
  via?: "reconnect_wake" | "no_followup_wake";
  env?: Env;
}): NotConnectedNotice {
  void input;
  return { headline: "", action: "", copyLine: "", footer: "" };
}

/** STUB (TDD) */
export function renderNotConnectedNotice(notice: NotConnectedNotice, format: NoticeFormat): string {
  void format;
  return [notice.headline, notice.action, notice.copyLine, notice.footer].join("\n");
}

/** STUB (TDD): machine e-mail lines (flag OFF → []). */
export function mcpHandoffMachineLines(): string[] {
  return [];
}

export type McpSeenCredential = {
  employeeId: string;
  orgId: string;
  credentialId: string | null;
  generation: number;
};



async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ts(event: AuditEvent): number {
  const t = new Date(event.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Anything the employee's own credential did (MCP or Gateway). */
export function isEmployeeCredentialActivity(event: AuditEvent, employeeId: string): boolean {
  if (!employeeId || event.employeeId !== employeeId) return false;
  return (
    event.action === MCP_CLIENT_SEEN_ACTION ||
    event.action === "tool.invoke" ||
    Boolean(event.credentialId)
  );
}

/**
 * Connection state for the wake payload. Fail-safe: any error / timeout → unknown.
 */
export async function getMcpConnectionState(
  orgId: string,
  employeeId: string
): Promise<{ status: McpConnectionStatus; lastSeenAt: string | null }> {
  const unknown = { status: "unknown" as const, lastSeenAt: null };
  if (!orgId || !employeeId) return unknown;
  const events = await withTimeout(
    listEmployeeAuditEvents(orgId, employeeId, 200).then((rows) => rows as AuditEvent[] | null),
    STATE_TIMEOUT_MS,
    null
  );
  if (!events) return unknown;
  let lastSeen = 0;
  let lastNotify = 0;
  for (const e of events) {
    const t = ts(e);
    if (isEmployeeCredentialActivity(e, employeeId)) lastSeen = Math.max(lastSeen, t);
    if (e.action === MCP_NOT_CONNECTED_NOTIFY_ACTION && e.employeeId === employeeId) {
      lastNotify = Math.max(lastNotify, t);
    }
  }
  const lastSeenAt = lastSeen ? new Date(lastSeen).toISOString() : null;
  if (lastNotify && lastNotify > lastSeen) return { status: "not_connected_suspected", lastSeenAt };
  if (lastSeen) return { status: "seen", lastSeenAt };
  return { status: "not_seen", lastSeenAt: null };
}

/**
 * Attach the handoff block to an outbound wake payload.
 * Flag OFF → returns the SAME object (byte-identical JSON, zero behavior change).
 */
export async function withMcpHandoff<T extends object>(
  payload: T,
  ctx: McpWakeContext
): Promise<T & { mcpHandoff?: McpHandoff }> {
  if (!isMcpEndpointHandoffEnabled()) return payload;
  try {
    const connection = await getMcpConnectionState(ctx.orgId, ctx.employeeId);
    return {
      ...payload,
      mcpHandoff: buildMcpHandoff({
        employeeId: ctx.employeeId,
        wake: { surface: ctx.surface, kind: ctx.kind, trigger: ctx.trigger },
        connection,
      }),
    };
  } catch {
    // Never block a wake because of the handoff block.
    return payload;
  }
}

/** Audit metadata to mark a wake that carried the handoff block. */
export function mcpHandoffWakeAuditMeta(
  body: { mcpHandoff?: McpHandoff },
  surface: McpHandoffSurface
): Record<string, unknown> {
  return body.mcpHandoff ? { mcpHandoff: true, surface } : {};
}

const seenThrottle = new Map<string, number>();

export function resetMcpClientSeenThrottleForTests(): void {
  seenThrottle.clear();
}

/**
 * Record that the bot reached Staffpass MCP with its badge. Call only AFTER
 * resolveEmployeeCredential succeeded. Throttled; never stores the secret.
 */
export async function recordMcpClientSeen(
  cred: McpSeenCredential,
  method: string,
  tool?: string
): Promise<void> {
  if (!isMcpEndpointHandoffEnabled()) return;
  if (!cred.orgId || !cred.employeeId) return;
  const key = `${cred.orgId}:${cred.employeeId}:${cred.credentialId ?? `g${cred.generation}`}`;
  const now = Date.now();
  const last = seenThrottle.get(key) ?? 0;
  if (now - last < MCP_CLIENT_SEEN_THROTTLE_MS) return;
  if (seenThrottle.size > 5_000) seenThrottle.clear();
  seenThrottle.set(key, now);
  await appendAuditEvent({
    orgId: cred.orgId,
    employeeId: cred.employeeId,
    credentialId: cred.credentialId,
    action: MCP_CLIENT_SEEN_ACTION,
    purpose: "mcp",
    summary: "Grok Bot が社員証で Staffpass MCP に接続",
    metadata: {
      method,
      ...(tool ? { tool: tool.slice(0, 64) } : {}),
      generation: cred.generation,
    },
  }).catch(() => undefined);
}

export function isMcpHandoffWakeAudit(event: AuditEvent): boolean {
  return (
    (MCP_HANDOFF_WAKE_ACTIONS as readonly string[]).includes(event.action) &&
    event.metadata?.mcpHandoff === true
  );
}

function wakeSurface(event: AuditEvent): McpHandoffSurface {
  const raw = event.metadata?.surface;
  if (isMcpHandoffSurface(raw)) return raw;
  return event.action.startsWith("slack.") ? "slack" : "web";
}

export type McpNotConnectedReason =
  | "not_handoff_wake"
  | "wake_not_delivered"
  | "no_employee"
  | "too_soon"
  | "too_old"
  | "activity_seen"
  | "insufficient_history"
  | "cooldown";

export function mcpNotConnectedItemId(wake: AuditEvent): string {
  return `mcp_nc:${wake.employeeId || "-"}:${wake.id}`;
}

/**
 * Pure decision. `audits` = this org's recent audits (any order);
 * `complete` = true when `audits` is the full history (not truncated by limit).
 */
export function evaluateMcpNotConnected(input: {
  wake: AuditEvent;
  audits: AuditEvent[];
  now: Date;
  complete: boolean;
}): { eligible: boolean; reason?: McpNotConnectedReason; itemId: string } {
  const { wake, audits, complete } = input;
  const now = input.now.getTime();
  const itemId = mcpNotConnectedItemId(wake);
  const no = (reason: McpNotConnectedReason) => ({ eligible: false, reason, itemId });
  if (!isMcpHandoffWakeAudit(wake)) return no("not_handoff_wake");
  if (wake.metadata?.reason !== "woke") return no("wake_not_delivered");
  const employeeId = wake.employeeId || "";
  if (!employeeId) return no("no_employee");
  const wakeAt = ts(wake);
  const age = now - wakeAt;
  if (age < MCP_NOT_CONNECTED_MIN_MS) return no("too_soon");
  if (age > MCP_NOT_CONNECTED_MAX_WAKE_AGE_MS) return no("too_old");
  const windowStart = wakeAt - MCP_ACTIVITY_LOOKBEHIND_MS;
  if (audits.some((a) => ts(a) >= windowStart && isEmployeeCredentialActivity(a, employeeId))) {
    return no("activity_seen");
  }
  if (!complete && !audits.some((a) => ts(a) <= windowStart)) return no("insufficient_history");
  if (
    audits.some(
      (a) =>
        a.action === MCP_NOT_CONNECTED_NOTIFY_ACTION &&
        a.employeeId === employeeId &&
        now - ts(a) < MCP_NOT_CONNECTED_COOLDOWN_MS
    )
  ) {
    return no("cooldown");
  }
  return { eligible: true, itemId };
}

function plainName(raw: string): string {
  return raw.replace(/[<>&]/g, "").slice(0, 80);
}

export function buildNotConnectedNextStepJa(input: {
  employeeId: string;
  displayName?: string | null;
  surface: McpHandoffSurface;
  minutesSinceWake: number;
  env?: Env;
}): string {
  const url = resolveMcpEndpointUrl(input.env ?? process.env);
  const name = plainName(input.displayName || input.employeeId);
  return [
    `⚠️ Staffpass: AI社員「${name}」の Grok Bot が Staffpass MCP に接続していません`,
    `${SURFACE_LABEL_JA[input.surface]} から起こしてから ${Math.floor(input.minutesSinceWake)} 分、社員証での Staffpass 呼び出しが一度もありません（返信 comm.reply もできません）。社員証の鍵ではなく、MCP の接続先が未設定の可能性が高いです。`,
    "次の一手:",
    `1. Grok Bot の MCP（コネクタ）設定に ${url} を追加（Streamable HTTP）`,
    "2. 認証ヘッダー Authorization: Bearer に発行済みの社員証（gb_emp_…）を設定（チャットに貼らない）",
    `3. Grok Bot で staffpass_whoami を実行し employeeId=${input.employeeId} が返ることを確認`,
    `employeeId=${input.employeeId}`,
    "この通知は同じ AI 社員につき 24 時間に 1 回までです。Staffpass が自動で起こし直すことはありません。",
  ].join("\n");
}

export type McpNotConnectedResult = {
  ok: boolean;
  employeeId: string;
  itemId: string;
  surface: McpHandoffSurface;
  notified: boolean;
  reason?: string;
};

async function resolveNotifyChannelId(
  orgId: string,
  notifyMouth: string | null | undefined,
  approvalChannelId: string | null | undefined
): Promise<string | null> {
  const mouth = (notifyMouth || "").trim();
  if (mouth) return mouth;
  const inbox = (approvalChannelId || "").trim();
  if (inbox) return inbox;
  const { getEnabledNotificationChannels } = await import("@/lib/data/notification-channels");
  const channels = await getEnabledNotificationChannels(orgId).catch(() => []);
  return channels.find((c) => c.isDefault)?.id ?? null;
}

export async function processMcpNotConnectedWatchForOrg(
  orgId: string,
  opts?: { now?: Date }
): Promise<McpNotConnectedResult[]> {
  if (!isMcpEndpointHandoffEnabled() || !orgId) return [];
  const now = opts?.now ?? new Date();
  const recent = await listAuditEventsForStuckWatch(orgId, WATCH_AUDIT_LIMIT);
  const complete = recent.length < WATCH_AUDIT_LIMIT;
  const priorNotices = await listAuditEventsByActionSince(
    orgId,
    MCP_NOT_CONNECTED_NOTIFY_ACTION,
    new Date(now.getTime() - MCP_NOT_CONNECTED_COOLDOWN_MS).toISOString()
  ).catch(() => [] as AuditEvent[]);
  const seenIds = new Set(recent.map((a) => a.id));
  const audits = [...recent, ...priorNotices.filter((a) => !seenIds.has(a.id))];

  const wakes = recent
    .filter((a) => a.orgId === orgId && isMcpHandoffWakeAudit(a))
    .sort((a, b) => ts(a) - ts(b));
  const handled = new Set<string>();
  const results: McpNotConnectedResult[] = [];
  if (!wakes.length) return results;

  const [{ getEmployee }, { getOrgStuckWatchPolicy }, { notifyStuckWatchMouth }] = await Promise.all([
    import("@/lib/data/employees"),
    import("@/lib/data/stuck-watch-policy"),
    import("@/lib/stuck-watch/notify-mouth"),
  ]);
  const policy = await getOrgStuckWatchPolicy(orgId);

  for (const wake of wakes) {
    const employeeId = wake.employeeId || "";
    if (!employeeId || handled.has(employeeId)) continue;
    const verdict = evaluateMcpNotConnected({ wake, audits, now, complete });
    if (!verdict.eligible) continue;
    handled.add(employeeId);
    // Tenant isolation: the employee must belong to this org.
    const employee = await getEmployee(employeeId, orgId).catch(() => null);
    if (!employee || (employee.orgId && employee.orgId !== orgId)) continue;

    const surface = wakeSurface(wake);
    const minutesSinceWake = (now.getTime() - ts(wake)) / 60_000;
    const message = buildNotConnectedNextStepJa({
      employeeId,
      displayName: employee.displayName,
      surface,
      minutesSinceWake,
    });
    const channelId = await resolveNotifyChannelId(orgId, policy.notifyMouth, employee.approvalChannelId);
    const mouth = channelId
      ? await notifyStuckWatchMouth(orgId, { ...policy, notifyMouth: channelId }, message, {
          itemId: verdict.itemId,
          kind: "mcp_not_connected",
        }).catch((error: unknown) => ({
          ok: false,
          skipped: false,
          error: error instanceof Error ? error.message : "notify_failed",
        }))
      : { ok: true, skipped: true, reason: "no_human_channel" };
    const delivered = mouth.ok && !mouth.skipped;

    const notice = {
      orgId,
      employeeId,
      credentialId: null,
      action: MCP_NOT_CONNECTED_NOTIFY_ACTION,
      purpose: "mcp_handoff",
      summary: `MCP 未接続の可能性（${SURFACE_LABEL_JA[surface]} wake 後 ${Math.floor(minutesSinceWake)} 分活動なし）`,
      metadata: {
        itemId: verdict.itemId,
        kind: "mcp_not_connected",
        wakeAuditId: wake.id,
        wakeAction: wake.action,
        surface,
        minutesSinceWake,
        notifyChannelId: channelId,
        mouthDelivered: delivered,
        mouthSkipped: mouth.skipped === true,
        mouthError: "error" in mouth ? mouth.error : undefined,
        mcpEndpointUrl: resolveMcpEndpointUrl(),
        nextAction: "register_mcp_endpoint",
      },
    };
    await appendAuditEvent(notice).catch(() => undefined);
    // Keep the in-memory view consistent for later wakes in this run.
    audits.push({ ...notice, id: `local_${verdict.itemId}`, createdAt: now.toISOString() } as AuditEvent);

    results.push({ ok: true, employeeId, itemId: verdict.itemId, surface, notified: delivered });
  }
  return results;
}

export async function processMcpNotConnectedWatchAllOrgs(): Promise<McpNotConnectedResult[]> {
  if (!isMcpEndpointHandoffEnabled()) return [];
  const audits = await listAuditEventsForStuckWatch(null, WATCH_AUDIT_LIMIT);
  const orgIds = new Set<string>();
  for (const a of audits) {
    if (a.orgId && isMcpHandoffWakeAudit(a)) orgIds.add(a.orgId);
  }
  const results: McpNotConnectedResult[] = [];
  for (const orgId of orgIds) {
    results.push(...(await processMcpNotConnectedWatchForOrg(orgId).catch(() => [])));
  }
  return results;
}
