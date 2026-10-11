/**
 * Emergency stop (hold) checkpoint — design ai-safety-5rules-design-20261012.md §2.3 (S2).
 *
 * One function, `checkOperable`, is called at every checkpoint (G1 credential,
 * G2 OAuth, G3 gateway entry, G4 post-approval execution, G5 wake / events /
 * cron, and right before an outbound send). It reads the employee's hold and
 * the org's hold (columns from migration 20261012500000, S1).
 *
 * Fail-stop: a read error, a missing row, an unexpected shape or a thrown
 * exception all count as STOPPED (`hold_state_unavailable`, audited, throttled).
 * There is NO flag here: the check is always on (EMPLOYEE_HOLD_ENABLED only
 * controls the stop / release UI in S3). With no hold rows nothing changes.
 *
 * Tickets: a ticket tagged by a hold (metadata.heldByHoldId) or closed by a
 * release (metadata.holdOutcome = "closed_by_hold") is never executed — not
 * during the hold, not after release (木村 10/12, decision 3: default discard).
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data/audit";

export type HoldKind = "stopped" | "leave" | "quarantined";
export type HoldPhase =
  | "credential" // G1
  | "oauth" // G2
  | "oauth_refresh" // G2
  | "oauth_consent" // G2 (consent candidates)
  | "gateway" // G3
  | "approval_execution" // G4
  | "wake" // G5
  | "mcp_events" // G5
  | "pre_send"; // just before an outbound adapter call

export type HoldDenyCode = "employee_on_hold" | "org_on_hold" | "hold_state_unavailable";
export type OperableResult =
  | { ok: true }
  | { ok: false; code: HoldDenyCode; holdId: string | null; kind: HoldKind | null };

export type HoldRead =
  | { state: "found"; orgId: string; holdState: string | null; holdId: string | null }
  | { state: "missing" }
  | { state: "error"; detail: string }
  /** The S1 migration is not applied yet (wrong-order deploy). See isHoldSchemaMissing. */
  | { state: "not_installed"; detail: string };

export type HoldReader = {
  employee(employeeId: string, orgHint?: string | null): Promise<HoldRead>;
  org(orgId: string): Promise<HoldRead>;
};

const KINDS: ReadonlySet<string> = new Set(["stopped", "leave", "quarantined"]);
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------
type DemoHold = { kind: HoldKind; holdId: string };
const demoEmployeeHolds = new Map<string, DemoHold>();
const demoOrgHolds = new Map<string, DemoHold>();

/** Demo / tests only (S3 demo uses it too). Never reachable in production. */
export function demoSetEmployeeHold(employeeId: string, hold: DemoHold | null): void {
  if (!isDemoMode()) throw new Error("demo_only");
  if (hold) demoEmployeeHolds.set(employeeId, hold);
  else demoEmployeeHolds.delete(employeeId);
}
export function demoSetOrgHold(orgId: string, hold: DemoHold | null): void {
  if (!isDemoMode()) throw new Error("demo_only");
  if (hold) demoOrgHolds.set(orgId, hold);
  else demoOrgHolds.delete(orgId);
}
export function demoGetEmployeeHold(employeeId: string): DemoHold | null {
  return demoEmployeeHolds.get(employeeId) ?? null;
}
export function demoGetOrgHold(orgId: string): DemoHold | null {
  return demoOrgHolds.get(orgId) ?? null;
}

function demoReader(): HoldReader {
  return {
    async employee(employeeId, orgHint) {
      // Demo has no DB: the in-memory hold map is the whole truth, so an employee the demo
      // store does not know (test fixtures behind mocked data layers) reads as "no hold" in
      // the caller's org. Production (supabaseReader) fails stop on a missing row instead.
      const h = demoEmployeeHolds.get(employeeId);
      const { getEmployeeById } = await import("@/lib/data/employees");
      const e = await getEmployeeById(employeeId).catch(() => null);
      return { state: "found", orgId: e?.orgId ?? orgHint ?? "", holdState: h?.kind ?? null, holdId: h?.holdId ?? null };
    },
    async org(orgId) {
      const h = demoOrgHolds.get(orgId);
      return { state: "found", orgId, holdState: h?.kind ?? null, holdId: h?.holdId ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// Wrong-order deploy safety net (木村 10/12, option (a)).
// If this code ships before migration 20261012500000, the hold columns don't exist
// and every read would fail closed → every tenant's AI employees 503. ONLY a
// "column / relation does not exist" error naming the hold schema counts as
// "not installed"; everything else (permission, timeout, network, other columns,
// missing row, other org, malformed value) still fails closed.
// supabase-js (postgrest-js 2.x) hands back PostgREST's JSON error body as-is:
// a Postgres error keeps its SQLSTATE in `code` (42703 undefined_column, 42P01
// undefined_table); PostgREST's own schema-cache errors are PGRST204 (column) /
// PGRST205 (table). The message must also name a hold column / table, so an
// unrelated missing column is never mistaken for this.
// The verdict is NOT cached: every request re-reads, so enforcement starts on
// the first request after the migration, with no deploy or restart.
// ---------------------------------------------------------------------------
const MISSING_COLUMN_CODES: ReadonlySet<string> = new Set(["42703", "PGRST204"]);
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);
const HOLD_COLUMN_RE = /\bhold_(state|id)\b/;
const HOLD_TABLE_RE = /\bemployee_holds\b/;
const MISSING_MSG_RE = /(does not exist|could not find)/i;

export function isHoldSchemaMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code.trim() : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (!MISSING_MSG_RE.test(message)) return false;
  if (MISSING_COLUMN_CODES.has(code)) return HOLD_COLUMN_RE.test(message);
  if (MISSING_TABLE_CODES.has(code)) return HOLD_TABLE_RE.test(message);
  // No code at all (proxy rewrote the body): only the exact Postgres wording for our columns.
  if (!code) return /column [\w."]*hold_(state|id)"? does not exist/i.test(message);
  return false;
}

export const HOLD_NOT_INSTALLED_ALERT_WINDOW_MS = 10 * 60_000;
type NotInstalledAlert = (info: { phase: HoldPhase; suppressed: number }) => Promise<void>;
let notInstalledAlertOverride: NotInstalledAlert | null = null;
let lastNotInstalledAlertAt = 0;
let suppressedNotInstalled = 0;
/** Tests only. */
export function __setHoldNotInstalledAlertForTests(fn: NotInstalledAlert | null): void {
  notInstalledAlertOverride = fn;
  lastNotInstalledAlertAt = 0;
  suppressedNotInstalled = 0;
}

async function defaultNotInstalledAlert(info: { phase: HoldPhase; suppressed: number }): Promise<void> {
  const line = "緊急停止（hold）の DB 列がありません（migration 20261012500000 が未適用）。停止の確認を飛ばして動かしています。至急 migration を当ててください。";
  console.error("employee_hold_not_installed", { phase: info.phase, suppressed: info.suppressed });
  const { appendAuditEvent } = await import("@/lib/data/audit");
  const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
  if (opsOrgId) {
    await appendAuditEvent({
      orgId: opsOrgId, employeeId: null, credentialId: null,
      action: "employee.hold.not_installed", purpose: null, summary: line,
      metadata: { auditClass: "admin", event: "employee.hold.not_installed", phase: info.phase, suppressed: info.suppressed },
    }).catch(() => undefined);
  }
  const to = (process.env.APPROVAL_ALERT_OPS_EMAILS || "").split(",").map((x) => x.trim()).filter((x) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x)).slice(0, 10);
  if (to.length) {
    const { sendTransactionalEmail } = await import("@/lib/resend");
    await sendTransactionalEmail({
      to, template: "oauth_security",
      subject: "【運営・至急】緊急停止の migration が未適用です（停止の確認が効いていません）",
      html: `<p>${line}</p><p>phase: ${info.phase}</p>`,
      text: `${line}\nphase: ${info.phase}`,
      tags: [{ name: "template", value: "oauth_security" }],
    }).catch(() => undefined);
  }
}

/** Loud, throttled (per process), ids / phase only — never PII. Never throws. */
async function alertNotInstalled(phase: HoldPhase): Promise<void> {
  const now = Date.now();
  if (now - lastNotInstalledAlertAt < HOLD_NOT_INSTALLED_ALERT_WINDOW_MS) {
    suppressedNotInstalled++;
    return;
  }
  lastNotInstalledAlertAt = now;
  const suppressed = suppressedNotInstalled;
  suppressedNotInstalled = 0;
  await (notInstalledAlertOverride ?? defaultNotInstalledAlert)({ phase, suppressed }).catch(() => undefined);
}

function supabaseReader(): HoldReader {
  return {
    async employee(employeeId) {
      const admin = createSupabaseAdminClient();
      if (!admin) return { state: "error", detail: "db_unavailable" };
      const { data, error } = await admin.from("employees").select("id, org_id, hold_state, hold_id").eq("id", employeeId).maybeSingle();
      if (error) return isHoldSchemaMissing(error) ? { state: "not_installed", detail: "employees" } : { state: "error", detail: "employee_read_error" };
      if (!data) return { state: "missing" };
      const r = data as Record<string, unknown>;
      return { state: "found", orgId: String(r.org_id ?? ""), holdState: (r.hold_state as string | null) ?? null, holdId: (r.hold_id as string | null) ?? null };
    },
    async org(orgId) {
      const admin = createSupabaseAdminClient();
      if (!admin) return { state: "error", detail: "db_unavailable" };
      const { data, error } = await admin.from("orgs").select("id, hold_state, hold_id").eq("id", orgId).maybeSingle();
      if (error) return isHoldSchemaMissing(error) ? { state: "not_installed", detail: "orgs" } : { state: "error", detail: "org_read_error" };
      if (!data) return { state: "missing" };
      const r = data as Record<string, unknown>;
      return { state: "found", orgId: String(r.id ?? ""), holdState: (r.hold_state as string | null) ?? null, holdId: (r.hold_id as string | null) ?? null };
    },
  };
}

let readerOverride: HoldReader | null = null;
/** Tests only: replace the reader (e.g. one that throws, to prove fail-stop). */
export function __setHoldReaderForTests(r: HoldReader | null): void {
  readerOverride = r;
}
function reader(): HoldReader {
  return readerOverride ?? (isDemoMode() ? demoReader() : supabaseReader());
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------
const unavailable = (): OperableResult => ({ ok: false, code: "hold_state_unavailable", holdId: null, kind: null });

/** A set hold must look exactly like S1 writes it; anything else is "can't tell" → stopped. */
function shapeOf(r: Extract<HoldRead, { state: "found" }>, allowed: ReadonlySet<string>): "none" | "held" | "bad" {
  if (r.holdState === null && r.holdId === null) return "none";
  if (typeof r.holdState === "string" && allowed.has(r.holdState) && typeof r.holdId === "string" && UUIDISH.test(r.holdId)) return "held";
  if (isDemoMode() && typeof r.holdState === "string" && allowed.has(r.holdState) && typeof r.holdId === "string" && r.holdId) return "held";
  return "bad";
}

export async function checkOperable(input: {
  orgId?: string | null;
  employeeId?: string | null;
  phase: HoldPhase;
}): Promise<OperableResult> {
  const employeeId = (input.employeeId ?? "").trim();
  let orgId = (input.orgId ?? "").trim();
  let result: OperableResult;
  let notInstalled = false;
  try {
    if (!employeeId && !orgId) {
      result = unavailable();
    } else {
      const rd = reader();
      result = { ok: true };
      if (employeeId) {
        const e = await rd.employee(employeeId, orgId || null);
        if (e.state === "not_installed") notInstalled = true; // nothing to enforce yet; org below
        else if (e.state !== "found") result = unavailable();
        else if (orgId && e.orgId !== orgId) result = unavailable(); // never another org's row
        else {
          orgId = orgId || e.orgId;
          const s = shapeOf(e, KINDS);
          if (s === "bad") result = unavailable();
          else if (s === "held") result = { ok: false, code: "employee_on_hold", holdId: e.holdId, kind: e.holdState as HoldKind };
        }
      }
      if (result.ok || result.code === "employee_on_hold") {
        // The org hold is checked too (an org stop outranks nothing but must never be skipped).
        if (!orgId) result = notInstalled ? result : unavailable();
        else {
          const o = await rd.org(orgId);
          if (o.state === "not_installed") notInstalled = true;
          else if (o.state !== "found" || o.orgId !== orgId) result = unavailable();
          else {
            const s = shapeOf(o, new Set(["stopped"]));
            if (s === "bad") result = unavailable();
            else if (s === "held" && result.ok) result = { ok: false, code: "org_on_hold", holdId: o.holdId, kind: "stopped" };
          }
        }
      }
    }
  } catch {
    result = unavailable();
  }
  if (!result.ok && result.code === "hold_state_unavailable") await auditUnavailable(orgId, employeeId, input.phase);
  else if (notInstalled) await alertNotInstalled(input.phase);
  return result;
}

export class HoldStopError extends Error {
  constructor(public readonly code: HoldDenyCode | "approval_held", public readonly holdId: string | null = null) {
    super(code);
    this.name = "HoldStopError";
  }
}

/** Throwing form for code paths that signal refusal by exception (G4, wake). */
export async function assertOperable(input: Parameters<typeof checkOperable>[0]): Promise<void> {
  const r = await checkOperable(input);
  if (!r.ok) throw new HoldStopError(r.code, r.holdId);
}

/** Hold-related refusal codes (all stop before any provider call). */
export const HOLD_STOP_CODES: ReadonlySet<string> = new Set(["employee_on_hold", "org_on_hold", "hold_state_unavailable", "approval_held"]);

// ---------------------------------------------------------------------------
// Held tickets
// ---------------------------------------------------------------------------
/**
 * A ticket a hold touched is never executed: tagged at stop (heldByHoldId) or
 * closed at release (holdOutcome closed_by_hold). It stays pending / approved
 * with only the marker (S1 leaves status alone); re-running it needs a NEW
 * approval (S3 re-approve creates a fresh ticket).
 */
export function heldTicketMarker(metadata: Record<string, unknown> | null | undefined): string | null {
  const m = metadata ?? {};
  const held = m.heldByHoldId;
  if (typeof held === "string" && held.trim()) return held.trim();
  if (held !== undefined && held !== null) return "invalid";
  if (m.holdOutcome !== undefined && m.holdOutcome !== null) return "closed";
  return null;
}

export function assertTicketNotHeld(approval: { metadata?: Record<string, unknown> | null }): void {
  const marker = heldTicketMarker(approval.metadata);
  if (marker) throw new HoldStopError("approval_held", marker === "invalid" || marker === "closed" ? null : marker);
}

// ---------------------------------------------------------------------------
// Audit (throttled; ids and a phase only)
// ---------------------------------------------------------------------------
const lastAudit = new Map<string, number>();
const AUDIT_WINDOW_MS = 5 * 60 * 1000;
async function auditUnavailable(orgId: string, employeeId: string, phase: HoldPhase): Promise<void> {
  if (!orgId) return; // nothing to attach the row to; the caller still stops
  const key = `${orgId}:${employeeId}:${phase}`;
  const now = Date.now();
  if ((lastAudit.get(key) ?? 0) + AUDIT_WINDOW_MS > now) return;
  lastAudit.set(key, now);
  await appendAuditEvent({
    orgId,
    employeeId: employeeId || null,
    credentialId: null,
    action: "employee.hold.state_unavailable",
    purpose: "safety.hold",
    summary: "hold_state_unavailable",
    metadata: { reason: "hold_state_unavailable", phase, auditClass: "admin" },
  }).catch(() => undefined);
}
export function __resetHoldAuditThrottleForTests(): void {
  lastAudit.clear();
}

/**
 * Right before an outbound adapter call (Slack post / file upload / SNS / mail) made
 * FOR an employee. Returns the refusal code, or null when the send may go out.
 * Sends without an employee (approval cards, operator notices) are not employee
 * work and are not stopped here — release notices must still reach people.
 */
export async function preSendHoldCode(orgId: string | null | undefined, employeeId: string | null | undefined): Promise<HoldDenyCode | null> {
  if (!(employeeId ?? "").trim()) return null;
  const r = await checkOperable({ orgId: orgId ?? null, employeeId, phase: "pre_send" });
  return r.ok ? null : r.code;
}

/** Tests only: a reader that answers "no hold" for every row in the caller's org. */
export const NO_HOLD_READER_FOR_TESTS: HoldReader = {
  employee: async (_employeeId, orgHint) => ({ state: "found", orgId: orgHint ?? "", holdState: null, holdId: null }),
  org: async (orgId) => ({ state: "found", orgId, holdState: null, holdId: null }),
};
