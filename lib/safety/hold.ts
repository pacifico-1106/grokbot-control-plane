import { AsyncLocalStorage } from "node:async_hooks";
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

export type HoldDenyCode = "employee_on_hold" | "org_on_hold" | "hold_state_unavailable" | "employee_terminated";
export type OperableResult =
  | { ok: true }
  | { ok: false; code: HoldDenyCode; holdId: string | null; kind: HoldKind | null };

export type HoldRead =
  | { state: "found"; orgId: string; holdState: string | null; holdId: string | null; status?: string | null }
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
      return { state: "found", orgId: e?.orgId ?? orgHint ?? "", holdState: h?.kind ?? null, holdId: h?.holdId ?? null, status: e?.status ?? "active" };
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

// ---------------------------------------------------------------------------
// 木村 10/12 07:15 (3): the safety net is ONLY for a schema that is ENTIRELY absent.
// When a hold read says "hold column / table missing", probe all five pieces; only if
// every one is missing is it "not installed". Partly present (or a probe that fails for
// another reason) → fail closed (503) + a loud ops alert. Never cached.
// ---------------------------------------------------------------------------
type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;
// Literal table names (the tenant-config write-path scanner forbids non-literal .from()).
// Read-only probes: select … limit 0.
const HOLD_SCHEMA_PIECES: ReadonlyArray<[string, (a: AdminClient) => PromiseLike<{ error: unknown }>]> = [
  ["employees.hold_state", (a) => a.from("employees").select("hold_state").limit(0)],
  ["employees.hold_id", (a) => a.from("employees").select("hold_id").limit(0)],
  ["orgs.hold_state", (a) => a.from("orgs").select("hold_state").limit(0)],
  ["orgs.hold_id", (a) => a.from("orgs").select("hold_id").limit(0)],
  ["employee_holds", (a) => a.from("employee_holds").select("id").limit(0)],
];
type SchemaPartialAlert = (info: { phase: HoldPhase | "read"; present: string[]; suppressed: number }) => Promise<void>;
let schemaPartialAlertOverride: SchemaPartialAlert | null = null;
let lastPartialAlertAt = 0;
let suppressedPartial = 0;
/** Tests only. */
export function __setHoldSchemaPartialAlertForTests(fn: SchemaPartialAlert | null): void {
  schemaPartialAlertOverride = fn;
  lastPartialAlertAt = 0;
  suppressedPartial = 0;
}
async function defaultSchemaPartialAlert(info: { phase: HoldPhase | "read"; present: string[]; suppressed: number }): Promise<void> {
  const line = "緊急停止（hold）の DB スキーマが一部だけあります（migration 20261012500000 が中途半端）。停止の確認ができないため止めています（503）。至急確認してください。";
  console.error("employee_hold_schema_partial", info);
  const { appendAuditEvent } = await import("@/lib/data/audit");
  const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
  if (opsOrgId) {
    await appendAuditEvent({
      orgId: opsOrgId, employeeId: null, credentialId: null, action: "employee.hold.not_installed", purpose: null, summary: line,
      metadata: { auditClass: "admin", event: "employee.hold.schema_partial", ...info },
    }).catch(() => undefined);
  }
  const to = (process.env.APPROVAL_ALERT_OPS_EMAILS || "").split(",").map((x) => x.trim()).filter((x) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x)).slice(0, 10);
  if (to.length) {
    const { sendTransactionalEmail } = await import("@/lib/resend");
    const present = info.present.join(", ") || "-";
    await sendTransactionalEmail({
      to, template: "oauth_security", subject: "【運営・至急】緊急停止の DB スキーマが一部だけです（AI社員を 503 で止めています）",
      html: `<p>${line}</p><p>present: ${present}</p>`, text: `${line}\npresent: ${present}`,
      tags: [{ name: "template", value: "oauth_security" }],
    }).catch(() => undefined);
  }
}
async function alertSchemaPartial(phase: HoldPhase | "read", present: string[]): Promise<void> {
  const now = Date.now();
  if (now - lastPartialAlertAt < HOLD_NOT_INSTALLED_ALERT_WINDOW_MS) { suppressedPartial++; return; }
  lastPartialAlertAt = now;
  const suppressed = suppressedPartial;
  suppressedPartial = 0;
  await (schemaPartialAlertOverride ?? defaultSchemaPartialAlert)({ phase, present, suppressed }).catch(() => undefined);
}

/** "absent" only when every hold column and the table are missing. */
async function probeHoldSchema(admin: AdminClient): Promise<{ verdict: "absent" | "partial"; present: string[] }> {
  const present: string[] = [];
  let unknown = false;
  await Promise.all(HOLD_SCHEMA_PIECES.map(async ([name, run]) => {
    try {
      const { error } = await run(admin);
      if (!error) present.push(name);
      else if (!isHoldSchemaMissing(error)) unknown = true;
    } catch {
      unknown = true;
    }
  }));
  return { verdict: present.length === 0 && !unknown ? "absent" : "partial", present: present.sort() };
}
async function schemaMissingVerdict(admin: AdminClient, detail: string): Promise<HoldRead> {
  const probe = await probeHoldSchema(admin);
  if (probe.verdict === "absent") return { state: "not_installed", detail };
  await alertSchemaPartial("read", probe.present);
  return { state: "error", detail: "hold_schema_partial" };
}

function supabaseReader(): HoldReader {
  return {
    async employee(employeeId) {
      const admin = createSupabaseAdminClient();
      if (!admin) return { state: "error", detail: "db_unavailable" };
      const { data, error } = await admin.from("employees").select("id, org_id, hold_state, hold_id, status").eq("id", employeeId).maybeSingle();
      if (error) return isHoldSchemaMissing(error) ? schemaMissingVerdict(admin, "employees") : { state: "error", detail: "employee_read_error" };
      if (!data) return { state: "missing" };
      const r = data as Record<string, unknown>;
      return { state: "found", orgId: String(r.org_id ?? ""), holdState: (r.hold_state as string | null) ?? null, holdId: (r.hold_id as string | null) ?? null, status: typeof r.status === "string" ? r.status : null };
    },
    async org(orgId) {
      const admin = createSupabaseAdminClient();
      if (!admin) return { state: "error", detail: "db_unavailable" };
      const { data, error } = await admin.from("orgs").select("id, hold_state, hold_id").eq("id", orgId).maybeSingle();
      if (error) return isHoldSchemaMissing(error) ? schemaMissingVerdict(admin, "orgs") : { state: "error", detail: "org_read_error" };
      if (!data) return { state: "missing" };
      const r = data as Record<string, unknown>;
      return { state: "found", orgId: String(r.id ?? ""), holdState: (r.hold_state as string | null) ?? null, holdId: (r.hold_id as string | null) ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-request reuse (木村 10/12 LOW): one invoke used to read employees + orgs at G1,
// G3 and again just before sending (up to 6 reads). Inside withHoldRequestScope the
// rows that were READ SUCCESSFULLY are reused by later checkpoints of the same
// request; errors / missing rows are never reused (re-read, still fail-stop), and the
// just-before-send check (phase pre_send) always re-reads and refreshes the scope.
// Nothing outlives the request.
// ---------------------------------------------------------------------------
// 木村 10/12 07:15 (1): reuse is ONLY for the early, back-to-back checks of one call
// (credential / OAuth → gateway entry). The late checkpoints — G4 post-approval execution
// (incl. after the claim), wake, MCP Events and just-before-send — ALWAYS re-read, and their
// fresh read refreshes the scope, so a later early check in the same call sees it too.
// The scope is one CALL (one JSON-RPC message): both MCP routes refuse batches today, and
// withHoldCallScope always starts empty, so a future batch handler wraps each element.
const REUSE_PHASES: ReadonlySet<HoldPhase> = new Set<HoldPhase>(["credential", "oauth", "oauth_refresh", "oauth_consent", "gateway"]);
type HoldScope = { employee: Map<string, HoldRead>; org: Map<string, HoldRead>; reads: number };
const holdScope = new AsyncLocalStorage<HoldScope>();
/** Joins an enclosing scope if there is one (used inside runGatewayInvoke). */
export function withHoldRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  if (holdScope.getStore()) return fn();
  return holdScope.run({ employee: new Map(), org: new Map(), reads: 0 }, fn);
}
/** Always a NEW, empty scope: one per individual call (route entry, each JSON-RPC message). */
export function withHoldCallScope<T>(fn: () => Promise<T>): Promise<T> {
  return holdScope.run({ employee: new Map(), org: new Map(), reads: 0 }, fn);
}
/** Tests only: reads made by the reader inside the current scope. */
export function __holdScopeReadsForTests(): number | null {
  return holdScope.getStore()?.reads ?? null;
}
function scoped(rd: HoldReader, phase: HoldPhase): HoldReader {
  const store = holdScope.getStore();
  if (!store) return rd;
  const reuse = REUSE_PHASES.has(phase);
  return {
    async employee(employeeId, orgHint) {
      const hit = reuse ? store.employee.get(employeeId) : undefined;
      if (hit) return hit;
      store.reads++;
      const r = await rd.employee(employeeId, orgHint);
      if (r.state === "found") store.employee.set(employeeId, r);
      else store.employee.delete(employeeId);
      return r;
    },
    async org(orgId) {
      const hit = reuse ? store.org.get(orgId) : undefined;
      if (hit) return hit;
      store.reads++;
      const r = await rd.org(orgId);
      if (r.state === "found") store.org.set(orgId, r);
      else store.org.delete(orgId);
      return r;
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

const ORG_KINDS: ReadonlySet<string> = new Set(["stopped"]);

export type LiveHold =
  | { state: "none" }
  | { state: "held"; holdId: string; kind: HoldKind }
  | { state: "unknown" };

/**
 * Dashboard pointer: the same orgs.hold_state / employees.hold_state columns
 * checkOperable (MCP) reads. Does not query employee_holds. Unreadable → unknown
 * (fail closed for the panel — never "none").
 */
export async function readLiveHold(input: {
  orgId: string;
  employeeId: string | null;
}): Promise<LiveHold> {
  const orgId = (input.orgId ?? "").trim();
  const employeeId = (input.employeeId ?? "").trim() || null;
  if (!orgId) return { state: "unknown" };
  try {
    const rd = reader();
    if (employeeId) {
      const e = await rd.employee(employeeId, orgId);
      if (e.state !== "found" || e.orgId !== orgId) return { state: "unknown" };
      const s = shapeOf(e, KINDS);
      if (s === "bad") return { state: "unknown" };
      if (s === "held") return { state: "held", holdId: e.holdId as string, kind: e.holdState as HoldKind };
      return { state: "none" };
    }
    const o = await rd.org(orgId);
    if (o.state !== "found" || o.orgId !== orgId) return { state: "unknown" };
    const s = shapeOf(o, ORG_KINDS);
    if (s === "bad") return { state: "unknown" };
    if (s === "held") return { state: "held", holdId: o.holdId as string, kind: "stopped" };
    return { state: "none" };
  } catch {
    return { state: "unknown" };
  }
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
  let sawInstalled = false; // a hold read that succeeded (the schema is there on that side)
  try {
    if (!employeeId && !orgId) {
      result = unavailable();
    } else {
      const rd = scoped(reader(), input.phase);
      result = { ok: true };
      if (employeeId) {
        const e = await rd.employee(employeeId, orgId || null);
        if (e.state === "not_installed") notInstalled = true; // nothing to enforce yet; org below
        else if (e.state !== "found") result = unavailable();
        else if (orgId && e.orgId !== orgId) { sawInstalled = true; result = unavailable(); } // never another org's row
        else {
          sawInstalled = true;
          orgId = orgId || e.orgId;
          if (e.status === "suspended") {
            result = { ok: false, code: "employee_terminated", holdId: null, kind: null };
          } else {
            const s = shapeOf(e, KINDS);
            if (s === "bad") result = unavailable();
            else if (s === "held") result = { ok: false, code: "employee_on_hold", holdId: e.holdId, kind: e.holdState as HoldKind };
          }
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
            sawInstalled = true;
            const s = shapeOf(o, new Set(["stopped"]));
            if (s === "bad") result = unavailable();
            else if (s === "held" && result.ok) result = { ok: false, code: "org_on_hold", holdId: o.holdId, kind: "stopped" };
          }
        }
      }
    }
    // 木村 10/12 07:15 (3): one side "not installed" while the other side read fine means a
    // partly present schema → fail closed + ops alert, never the safety net.
    if (notInstalled && sawInstalled) {
      notInstalled = false;
      result = unavailable();
      await alertSchemaPartial(input.phase, []);
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
export const HOLD_STOP_CODES: ReadonlySet<string> = new Set(["employee_on_hold", "org_on_hold", "hold_state_unavailable", "approval_held", "employee_terminated"]);

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
/** Bounded throttle map (木村 10/12): never more than HOLD_THROTTLE_MAX_KEYS entries. */
export const HOLD_THROTTLE_MAX_KEYS = 1000;
export function takeHoldThrottleSlot(map: Map<string, number>, key: string, windowMs: number, now = Date.now()): boolean {
  const last = map.get(key);
  if (last !== undefined && last + windowMs > now) return false;
  map.delete(key); // re-insert at the end (insertion order = age)
  if (map.size >= HOLD_THROTTLE_MAX_KEYS) {
    for (const [k, t] of map) {
      if (t + windowMs <= now) map.delete(k);
    }
    while (map.size >= HOLD_THROTTLE_MAX_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, now);
  return true;
}

const wakeAuditThrottle = new Map<string, number>();
export const WAKE_SUPPRESSED_AUDIT_WINDOW_MS = 10 * 60_000;
/** One wake_suppressed row per org × employee × reason per window; the rest are counted. */
export function takeWakeSuppressedAuditSlot(key: string): { write: boolean; suppressed: number } {
  const countKey = `n:${key}`;
  const write = takeHoldThrottleSlot(wakeAuditThrottle, key, WAKE_SUPPRESSED_AUDIT_WINDOW_MS);
  const suppressed = wakeSuppressedCounts.get(countKey) ?? 0;
  if (write) wakeSuppressedCounts.delete(countKey);
  else {
    if (wakeSuppressedCounts.size >= HOLD_THROTTLE_MAX_KEYS && !wakeSuppressedCounts.has(countKey)) {
      const oldest = wakeSuppressedCounts.keys().next().value;
      if (oldest !== undefined) wakeSuppressedCounts.delete(oldest);
    }
    wakeSuppressedCounts.set(countKey, suppressed + 1);
  }
  return { write, suppressed: write ? suppressed : suppressed + 1 };
}
const wakeSuppressedCounts = new Map<string, number>();
export function __holdThrottleSizesForTests(): { unavailable: number; wake: number; wakeCounts: number } {
  return { unavailable: lastAudit.size, wake: wakeAuditThrottle.size, wakeCounts: wakeSuppressedCounts.size };
}

async function auditUnavailable(orgId: string, employeeId: string, phase: HoldPhase): Promise<void> {
  if (!orgId) return; // nothing to attach the row to; the caller still stops
  const key = `${orgId}:${employeeId}:${phase}`;
  if (!takeHoldThrottleSlot(lastAudit, key, AUDIT_WINDOW_MS)) return;
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
  lastPartialAlertAt = 0;
  suppressedPartial = 0;
  lastAudit.clear();
  wakeAuditThrottle.clear();
  wakeSuppressedCounts.clear();
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
