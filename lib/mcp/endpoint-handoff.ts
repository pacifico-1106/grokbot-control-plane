/**
 * MCP endpoint handoff — the ONE shared, channel-independent place that
 *
 *  1. builds the secret-free, machine-readable `mcpHandoff` block (endpoint from
 *     the app base URL config, connection steps, connectivity-check tool), used by
 *     employees.issue / link results and by every agent wake (Slack user-token
 *     channel / user-token IM / bot mention / internal IM, and approval.resolved
 *     callbacks + machine e-mail from Slack / LINE / Telegram / Web / proxy);
 *  2. records the "bot actually reached Staffpass MCP" signal (`mcp.client_seen`);
 *  3. detects "woken but never connected": first arms a stronger reconnect prompt on
 *     the employee's NEXT wake (no human, no re-wake); only if that also fails, tells a
 *     human ONE action through the org's notification mouth (Slack / LINE / Telegram alike);
 *  4. brands every wake body (McpHandoffWakeBody) so the shared sender
 *     (lib/mcp/wake-delivery.ts) refuses anything that skipped withMcpHandoff().
 *
 * Channel code only passes its surface name. Flag: MCP_ENDPOINT_HANDOFF_ENABLED
 * (default OFF → every function here is a no-op / identity).
 *
 * Fail-safe: when in doubt, do NOT notify. Never re-wakes the bot (no loops).
 * Never includes secrets (badge, wake secret, status tokens, signed URLs, tokens).
 */
import {
  MCP_HANDOFF_SCHEMA,
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

/**
 * Brand: only withMcpHandoff() can produce this type (the symbol is not exported and
 * has no runtime value). deliverAgentWake() only accepts it, so a new channel wake that
 * skips the wrapper fails `tsc` / `next build`.
 */
declare const MCP_HANDOFF_WAKE: unique symbol;
export type McpHandoffWakeBody<T extends object> = T & { mcpHandoff?: McpHandoff } & {
  readonly [MCP_HANDOFF_WAKE]: true;
};

/** Runtime half of the brand (casts cannot forge membership). */
const HANDED_OFF_WAKES = new WeakSet<object>();

/** True only for the exact object returned by withMcpHandoff(). */
export function isHandedOffWake(body: unknown): boolean {
  return typeof body === "object" && body !== null && HANDED_OFF_WAKES.has(body);
}

function brand<T extends object>(body: T): McpHandoffWakeBody<T> {
  HANDED_OFF_WAKES.add(body);
  return body as McpHandoffWakeBody<T>;
}

/** Stage-1 "reconnect prompt armed" audit (nobody notified, nothing re-woken). */
export const MCP_RECONNECT_ARMED_ACTION = "mcp_handoff.reconnect_armed" as const;
/** Fallback: no further wake within this window after arming → the one human notice. */
export const MCP_RECONNECT_ESCALATE_MS = 60 * 60_000;

export type NotConnectedNotice = {
  headline: string;
  action: string;
  copyLine: string;
  footer: string;
};
export type NoticeFormat = "slack" | "telegram" | "line" | "plain";

export type McpNotConnectedVia = "reconnect_wake" | "no_followup_wake";

function plainName(raw: string): string {
  return raw.replace(/[<>&]/g, "").slice(0, 80);
}

function plainId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
}

/**
 * The human notice (last resort): exactly ONE thing to do — paste one line into the main
 * Grok Bot chat. The line is secret-free (endpoint URL + whoami check only).
 * Same wording on every channel; renderNotConnectedNotice() only escapes.
 */
export function buildNotConnectedNotice(input: {
  employeeId: string;
  displayName?: string | null;
  surface: McpHandoffSurface;
  minutesSinceWake: number;
  via?: McpNotConnectedVia;
  env?: Env;
}): NotConnectedNotice {
  const url = resolveMcpEndpointUrl(input.env ?? process.env);
  const employeeId = plainId(input.employeeId);
  const name = plainName(input.displayName || employeeId);
  const minutes = Math.max(0, Math.floor(input.minutesSinceWake));
  const surface = SURFACE_LABEL_JA[input.surface];
  const why =
    input.via === "reconnect_wake"
      ? `${surface} から起こしてから ${minutes} 分、接続を促す合図付きで起こしても社員証での呼び出しがありません`
      : `${surface} から起こした後、社員証での呼び出しが一度もありません（${minutes} 分経過）`;
  return {
    headline: `⚠️ Staffpass: AI社員「${name}」の Grok Bot が Staffpass MCP に接続していません。${why}。`,
    action: "やることは 1 つです。次の 1 行をそのまま、メインの Grok Bot のチャットに送ってください。",
    copyLine: `Staffpass MCP に接続して: コネクタに ${url} を追加し（Streamable HTTP、認証は発行済みの社員証を Authorization: Bearer で設定）、staffpass_whoami を呼んで employeeId=${employeeId} が返ることを確認して。`,
    footer: "この通知は同じ AI 社員につき 24 時間に 1 回までです。Staffpass が自動で起こし直すことはありません。",
  };
}

function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegram(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Same text everywhere; only escaping / the copyable wrapper differs per channel. */
export function renderNotConnectedNotice(notice: NotConnectedNotice, format: NoticeFormat): string {
  const { headline, action, copyLine, footer } = notice;
  if (format === "slack") {
    return [escapeSlack(headline), escapeSlack(action), "```\n" + escapeSlack(copyLine) + "\n```", escapeSlack(footer)].join("\n");
  }
  if (format === "telegram") {
    return [escapeTelegram(headline), escapeTelegram(action), `<code>${escapeTelegram(copyLine)}</code>`, escapeTelegram(footer)].join("\n");
  }
  // LINE / plain: no markup.
  return [headline, action, copyLine, footer].join("\n");
}

/** Machine e-mail lines (flag OFF → []). Same values as before; owned here. */
export function mcpHandoffMachineLines(): string[] {
  if (!isMcpEndpointHandoffEnabled()) return [];
  return [
    `mcpEndpoint=${resolveMcpEndpointUrl()}`,
    "mcpConnectivityCheck=staffpass_whoami",
    `mcpHandoffSchema=${MCP_HANDOFF_SCHEMA}`,
  ];
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

/** Arm time = the watcher clock that armed it (metadata.armedAt), else the row time. */
function armTs(event: AuditEvent): number {
  const raw = event.metadata?.armedAt;
  const t = typeof raw === "string" ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : ts(event);
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
export type McpConnectionState = {
  status: McpConnectionStatus;
  lastSeenAt: string | null;
  /** A reconnect arm / notice (last 24h) is newer than the last MCP activity → stronger prompt. */
  reconnectRequired: boolean;
};

export async function getMcpConnectionState(
  orgId: string,
  employeeId: string
): Promise<McpConnectionState> {
  const unknown = { status: "unknown" as const, lastSeenAt: null, reconnectRequired: false };
  if (!orgId || !employeeId) return unknown;
  const events = await withTimeout(
    listEmployeeAuditEvents(orgId, employeeId, 200).then((rows) => rows as AuditEvent[] | null),
    STATE_TIMEOUT_MS,
    null
  );
  if (!events) return unknown;
  let lastSeen = 0;
  let lastNotify = 0;
  let lastArm = 0;
  for (const e of events) {
    const t = ts(e);
    if (isEmployeeCredentialActivity(e, employeeId)) lastSeen = Math.max(lastSeen, t);
    if (e.action === MCP_NOT_CONNECTED_NOTIFY_ACTION && e.employeeId === employeeId) {
      lastNotify = Math.max(lastNotify, t);
    }
    if (
      e.action === MCP_RECONNECT_ARMED_ACTION &&
      e.employeeId === employeeId &&
      Date.now() - t <= MCP_NOT_CONNECTED_COOLDOWN_MS
    ) {
      lastArm = Math.max(lastArm, t, armTs(e));
    }
  }
  const lastSeenAt = lastSeen ? new Date(lastSeen).toISOString() : null;
  const lastSignal = Math.max(lastNotify, lastArm);
  if (lastSignal && lastSignal > lastSeen) {
    return { status: "not_connected_suspected", lastSeenAt, reconnectRequired: true };
  }
  if (lastSeen) return { status: "seen", lastSeenAt, reconnectRequired: false };
  return { status: "not_seen", lastSeenAt: null, reconnectRequired: false };
}

/**
 * Attach the handoff block to an outbound wake payload.
 * Flag OFF → returns the SAME object (byte-identical JSON, zero behavior change).
 */
export async function withMcpHandoff<T extends object>(
  payload: T,
  ctx: McpWakeContext
): Promise<McpHandoffWakeBody<T>> {
  if (!isMcpEndpointHandoffEnabled()) return brand(payload);
  try {
    const { status, lastSeenAt, reconnectRequired } = await getMcpConnectionState(ctx.orgId, ctx.employeeId);
    return brand({
      ...payload,
      mcpHandoff: buildMcpHandoff({
        employeeId: ctx.employeeId,
        wake: { surface: ctx.surface, kind: ctx.kind, trigger: ctx.trigger },
        connection: { status, lastSeenAt },
        reconnectRequired,
      }),
    });
  } catch {
    // Never block a wake because of the handoff block.
    return brand(payload);
  }
}

/** Audit metadata to mark a wake that carried the handoff block (and the reconnect prompt). */
export function mcpHandoffWakeAuditMeta(
  body: { mcpHandoff?: McpHandoff },
  surface: McpHandoffSurface
): Record<string, unknown> {
  if (!body.mcpHandoff) return {};
  return {
    mcpHandoff: true,
    surface,
    ...(body.mcpHandoff.reconnectRequired ? { mcpReconnectRequired: true } : {}),
  };
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

/** Plain-text notice (kept for callers of the #254 API). */
export function buildNotConnectedNextStepJa(input: {
  employeeId: string;
  displayName?: string | null;
  surface: McpHandoffSurface;
  minutesSinceWake: number;
  via?: McpNotConnectedVia;
  env?: Env;
}): string {
  return renderNotConnectedNotice(buildNotConnectedNotice(input), "plain");
}

export type McpNotConnectedStage = "armed" | "notified";

export type McpNotConnectedResult = {
  ok: boolean;
  employeeId: string;
  itemId: string;
  surface: McpHandoffSurface;
  /** armed = reconnect prompt queued for the next wake (nobody told); notified = the one human notice. */
  stage: McpNotConnectedStage;
  notified: boolean;
  via?: McpNotConnectedVia;
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

type WakeFacts = {
  itemId: string;
  wakeAuditId: string | null;
  wakeAction: string | null;
  surface: McpHandoffSurface;
  wakeAt: number;
};

export type McpEscalationDecision =
  | { kind: "arm"; facts: WakeFacts }
  | { kind: "notify"; via: McpNotConnectedVia; facts: WakeFacts; armAuditId: string }
  | { kind: "wait" | "skip"; reason: string };

function wakeFacts(wake: AuditEvent, itemId: string): WakeFacts {
  return { itemId, wakeAuditId: wake.id, wakeAction: wake.action, surface: wakeSurface(wake), wakeAt: ts(wake) };
}

function armFacts(arm: AuditEvent): WakeFacts {
  const m = arm.metadata || {};
  const wakeAt = typeof m.wakeAt === "string" ? new Date(m.wakeAt).getTime() : NaN;
  return {
    itemId: typeof m.itemId === "string" ? m.itemId : `mcp_nc:${arm.employeeId || "-"}:${arm.id}`,
    wakeAuditId: typeof m.wakeAuditId === "string" ? m.wakeAuditId : null,
    wakeAction: typeof m.wakeAction === "string" ? m.wakeAction : null,
    surface: isMcpHandoffSurface(m.surface) ? m.surface : "web",
    wakeAt: Number.isFinite(wakeAt) ? wakeAt : armTs(arm),
  };
}

/**
 * Pure escalation ladder for ONE employee (bounded, never re-wakes):
 *  - a notice in the last 24h → skip (one notice per 24h, unchanged);
 *  - no valid arm (arm newer than the last MCP activity, < 24h old) → arm on the latest
 *    eligible wake (stage 1: the NEXT wake carries reconnectRequired; nobody is told);
 *  - armed + a delivered reconnect wake that is also ≥10 min silent → notify (reconnect_wake);
 *  - armed + a reconnect wake still inside its 10 minutes → wait;
 *  - armed + no reconnect wake for MCP_RECONNECT_ESCALATE_MS → notify (no_followup_wake).
 * `wakes` = this employee's handoff wakes; `audits` = org audits incl. arms / notices.
 */
export function decideMcpNotConnectedStage(input: {
  employeeId: string;
  wakes: AuditEvent[];
  audits: AuditEvent[];
  now: Date;
  complete: boolean;
}): McpEscalationDecision {
  const { employeeId, audits, complete } = input;
  const now = input.now.getTime();
  const mine = (a: AuditEvent) => a.employeeId === employeeId;
  if (audits.some((a) => mine(a) && a.action === MCP_NOT_CONNECTED_NOTIFY_ACTION && now - ts(a) < MCP_NOT_CONNECTED_COOLDOWN_MS)) {
    return { kind: "skip", reason: "cooldown" };
  }
  let lastActivity = 0;
  for (const a of audits) if (isEmployeeCredentialActivity(a, employeeId)) lastActivity = Math.max(lastActivity, ts(a));
  const arm = audits
    .filter(
      (a) =>
        mine(a) &&
        a.action === MCP_RECONNECT_ARMED_ACTION &&
        now - armTs(a) <= MCP_NOT_CONNECTED_MAX_WAKE_AGE_MS &&
        armTs(a) > lastActivity
    )
    .sort((a, b) => armTs(b) - armTs(a))[0];
  const wakes = [...input.wakes].sort((a, b) => ts(a) - ts(b));

  if (!arm) {
    for (const wake of [...wakes].reverse()) {
      const verdict = evaluateMcpNotConnected({ wake, audits, now: input.now, complete });
      if (verdict.eligible) return { kind: "arm", facts: wakeFacts(wake, verdict.itemId) };
    }
    return { kind: "skip", reason: "no_eligible_wake" };
  }

  const armAt = armTs(arm);
  const reconnectWakes = wakes.filter(
    (w) => w.metadata?.mcpReconnectRequired === true && w.metadata?.reason === "woke" && ts(w) >= armAt
  );
  if (reconnectWakes.length) {
    for (const wake of reconnectWakes) {
      const verdict = evaluateMcpNotConnected({ wake, audits, now: input.now, complete });
      if (verdict.eligible) {
        return { kind: "notify", via: "reconnect_wake", facts: wakeFacts(wake, verdict.itemId), armAuditId: arm.id };
      }
    }
    return { kind: "wait", reason: "reconnect_wake_pending" };
  }
  if (now - armAt < MCP_RECONNECT_ESCALATE_MS) return { kind: "wait", reason: "armed_waiting_for_next_wake" };
  // Fail-safe: a truncated history that does not reach back before the arm → do not notify.
  if (!complete && !audits.some((a) => ts(a) <= armAt - MCP_ACTIVITY_LOOKBEHIND_MS)) {
    return { kind: "skip", reason: "insufficient_history" };
  }
  return { kind: "notify", via: "no_followup_wake", facts: armFacts(arm), armAuditId: arm.id };
}

export async function processMcpNotConnectedWatchForOrg(
  orgId: string,
  opts?: { now?: Date }
): Promise<McpNotConnectedResult[]> {
  if (!isMcpEndpointHandoffEnabled() || !orgId) return [];
  const now = opts?.now ?? new Date();
  const recent = await listAuditEventsForStuckWatch(orgId, WATCH_AUDIT_LIMIT);
  const complete = recent.length < WATCH_AUDIT_LIMIT;
  const sinceIso = new Date(now.getTime() - MCP_NOT_CONNECTED_COOLDOWN_MS).toISOString();
  const [priorNotices, priorArms] = await Promise.all([
    listAuditEventsByActionSince(orgId, MCP_NOT_CONNECTED_NOTIFY_ACTION, sinceIso).catch(() => [] as AuditEvent[]),
    listAuditEventsByActionSince(orgId, MCP_RECONNECT_ARMED_ACTION, sinceIso).catch(() => [] as AuditEvent[]),
  ]);
  const seenIds = new Set(recent.map((a) => a.id));
  const audits = [...recent];
  for (const a of [...priorNotices, ...priorArms]) {
    if (!seenIds.has(a.id)) {
      seenIds.add(a.id);
      audits.push(a);
    }
  }

  const wakes = recent
    .filter((a) => a.orgId === orgId && isMcpHandoffWakeAudit(a))
    .sort((a, b) => ts(a) - ts(b));
  const employeeIds: string[] = [];
  for (const a of [...wakes, ...audits.filter((x) => x.action === MCP_RECONNECT_ARMED_ACTION && x.orgId === orgId)]) {
    const id = a.employeeId || "";
    if (id && !employeeIds.includes(id)) employeeIds.push(id);
  }
  const results: McpNotConnectedResult[] = [];
  if (!employeeIds.length) return results;

  const [{ getEmployee }, { getOrgStuckWatchPolicy }, { notifyStuckWatchMouth }] = await Promise.all([
    import("@/lib/data/employees"),
    import("@/lib/data/stuck-watch-policy"),
    import("@/lib/stuck-watch/notify-mouth"),
  ]);
  const policy = await getOrgStuckWatchPolicy(orgId);

  for (const employeeId of employeeIds) {
    const decision = decideMcpNotConnectedStage({
      employeeId,
      wakes: wakes.filter((w) => w.employeeId === employeeId),
      audits,
      now,
      complete,
    });
    if (decision.kind !== "arm" && decision.kind !== "notify") continue;
    // Tenant isolation: the employee must belong to this org.
    const employee = await getEmployee(employeeId, orgId).catch(() => null);
    if (!employee || (employee.orgId && employee.orgId !== orgId)) continue;
    const { facts } = decision;
    const minutesSinceWake = Math.max(0, (now.getTime() - facts.wakeAt) / 60_000);

    if (decision.kind === "arm") {
      // Stage 1: nobody is told, nothing is re-woken. The next natural wake (any channel)
      // carries reconnectRequired + the stronger prompt (getMcpConnectionState).
      const arm = {
        orgId,
        employeeId,
        credentialId: null,
        action: MCP_RECONNECT_ARMED_ACTION,
        purpose: "mcp_handoff",
        summary: `MCP 未接続の疑い: 次の起動時に接続の再確認を促す（${SURFACE_LABEL_JA[facts.surface]} wake 後 ${Math.floor(minutesSinceWake)} 分活動なし）`,
        metadata: {
          itemId: facts.itemId,
          kind: "mcp_not_connected",
          stage: "armed",
          armedAt: now.toISOString(),
          wakeAuditId: facts.wakeAuditId,
          wakeAction: facts.wakeAction,
          wakeAt: new Date(facts.wakeAt).toISOString(),
          surface: facts.surface,
          minutesSinceWake,
          nextAction: "reconnect_prompt_on_next_wake",
        },
      };
      await appendAuditEvent(arm).catch(() => undefined);
      audits.push({ ...arm, id: `local_arm_${facts.itemId}`, createdAt: now.toISOString() } as AuditEvent);
      results.push({ ok: true, employeeId, itemId: facts.itemId, surface: facts.surface, stage: "armed", notified: false });
      continue;
    }

    // Stage 2 (last resort): ONE notice with exactly one action, same text on every mouth.
    const notice = buildNotConnectedNotice({
      employeeId,
      displayName: employee.displayName,
      surface: facts.surface,
      minutesSinceWake,
      via: decision.via,
    });
    const plain = renderNotConnectedNotice(notice, "plain");
    const channelId = await resolveNotifyChannelId(orgId, policy.notifyMouth, employee.approvalChannelId);
    const mouth = channelId
      ? await notifyStuckWatchMouth(
          orgId,
          { ...policy, notifyMouth: channelId },
          plain,
          { itemId: facts.itemId, kind: "mcp_not_connected" },
          {
            slack: renderNotConnectedNotice(notice, "slack"),
            line: renderNotConnectedNotice(notice, "line"),
            telegram: renderNotConnectedNotice(notice, "telegram"),
          }
        ).catch((error: unknown) => ({
          ok: false,
          skipped: false,
          error: error instanceof Error ? error.message : "notify_failed",
        }))
      : { ok: true, skipped: true, reason: "no_human_channel" };
    const delivered = mouth.ok && !mouth.skipped;

    const row = {
      orgId,
      employeeId,
      credentialId: null,
      action: MCP_NOT_CONNECTED_NOTIFY_ACTION,
      purpose: "mcp_handoff",
      summary: `MCP 未接続の可能性（${SURFACE_LABEL_JA[facts.surface]} wake 後 ${Math.floor(minutesSinceWake)} 分活動なし）`,
      metadata: {
        itemId: facts.itemId,
        kind: "mcp_not_connected",
        stage: "notified",
        via: decision.via,
        armAuditId: decision.armAuditId,
        wakeAuditId: facts.wakeAuditId,
        wakeAction: facts.wakeAction,
        surface: facts.surface,
        minutesSinceWake,
        notifyChannelId: channelId,
        mouthDelivered: delivered,
        mouthSkipped: mouth.skipped === true,
        mouthError: "error" in mouth ? mouth.error : undefined,
        mcpEndpointUrl: resolveMcpEndpointUrl(),
        nextAction: "send_one_line_to_main_bot",
      },
    };
    await appendAuditEvent(row).catch(() => undefined);
    // Keep the in-memory view consistent for the rest of this run.
    audits.push({ ...row, id: `local_${facts.itemId}`, createdAt: now.toISOString() } as AuditEvent);

    results.push({
      ok: true,
      employeeId,
      itemId: facts.itemId,
      surface: facts.surface,
      stage: "notified",
      via: decision.via,
      notified: delivered,
    });
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
