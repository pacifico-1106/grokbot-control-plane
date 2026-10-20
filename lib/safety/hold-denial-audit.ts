/**
 * HOLD_DENIAL_AUDIT_ENABLED (default OFF): record two hold refusals that
 * are otherwise silent. Observation only — a write failure must never change
 * the denial (fail-closed). Never token, header, hash, or prefix.
 *
 * (1) self_approval_denied → audit_events (tenant-scoped).
 * (2) MCP org_on_hold / employee_on_hold 403 → mcp_auth_failures via
 *     record_hold_mcp_denial (unique kind×org×employee×1-min bucket).
 */
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import { isHoldDenialAuditEnabled } from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";

export { isHoldDenialAuditEnabled };

export const SELF_APPROVAL_DENIED_AUDIT_ACTION = "employee.hold.self_approval_denied" as const;
export const HOLD_MCP_DENIAL_KINDS = ["org_on_hold", "employee_on_hold"] as const;
export type HoldMcpDenialKind = (typeof HOLD_MCP_DENIAL_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD = /^[A-Za-z0-9_./-]{1,64}$/;
const HOLD_KINDS = new Set<string>(HOLD_MCP_DENIAL_KINDS);

/** Hard cap so a hung insert cannot stall the 403. */
export const HOLD_DENIAL_AUDIT_TIMEOUT_MS = 250;

export type SelfApprovalDeniedAuditInput = {
  orgId: string;
  holdId: string;
  employeeId?: string | null;
  memberId: string;
  actorEmail?: string | null;
  requestedBy?: string | null;
  reason?: string | null;
};

export type McpHoldDeniedAuditInput = {
  kind: string;
  orgId?: string | null;
  employeeId?: string | null;
  holdId?: string | null;
  credentialId?: string | null;
  method?: string | null;
  /** Accepted only so callers can pass the header; NEVER forwarded to SQL. */
  presentedSecret?: string | null;
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hold_denial_audit_timeout")), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

export async function recordSelfApprovalDenied(input: SelfApprovalDeniedAuditInput): Promise<void> {
  try {
    if (!isHoldDenialAuditEnabled()) return;
    const orgId = (input.orgId || "").trim();
    const holdId = (input.holdId || "").trim();
    const memberId = (input.memberId || "").trim();
    if (!orgId || !holdId || !memberId) return;
    const reason = (input.reason || "self_approval_denied").trim() || "self_approval_denied";
    await appendAuditEvent({
      orgId,
      employeeId: input.employeeId ?? null,
      credentialId: null,
      action: SELF_APPROVAL_DENIED_AUDIT_ACTION,
      purpose: SELF_APPROVAL_DENIED_AUDIT_ACTION,
      summary: "申請した本人による解除承認を拒否しました",
      actorEmail: input.actorEmail ?? null,
      metadata: {
        auditClass: "admin",
        holdId,
        memberId,
        actor: `member:${memberId}`,
        reason,
        ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      },
    });
  } catch {
    // observation only
  }
}

export async function recordMcpHoldDenied(input: McpHoldDeniedAuditInput): Promise<void> {
  try {
    if (!isHoldDenialAuditEnabled()) return;
    if (!HOLD_KINDS.has(input.kind)) return;
    if (isDemoMode()) return;
    const orgId = uuidOrNull(input.orgId);
    if (!orgId) return;
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    const method = typeof input.method === "string" && METHOD.test(input.method) ? input.method : null;
    await withTimeout(
      Promise.resolve(
        admin.rpc("record_hold_mcp_denial", {
          p_kind: input.kind,
          p_org_id: orgId,
          p_employee_id: uuidOrNull(input.employeeId),
          p_hold_id: uuidOrNull(input.holdId),
          p_method: method,
        })
      ),
      HOLD_DENIAL_AUDIT_TIMEOUT_MS
    );
  } catch {
    // observation only
  }
}
