/**
 * MCP_AUTH_FAILURE_AUDIT_ENABLED (default OFF): record /api/mcp auth failures.
 * Production: public.record_mcp_auth_failure (migration 20261016400000) —
 * throttled insert, ids + kind + method only. Never the token or its hash.
 * Flag OFF / demo / missing RPC → no write. Never throws.
 */
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import { isMcpAuthFailureAuditEnabled } from "@/lib/feature-flags";
import type { McpAuthFailureKind } from "@/lib/auth/mcp-auth-failure";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = new Set<McpAuthFailureKind>(["missing_credential", "invalid", "expired"]);
const METHOD = /^[A-Za-z0-9_./-]{1,64}$/;

/** Hard cap for the background audit insert. 401 already returned via `void`. */
export const MCP_AUTH_FAILURE_TIMEOUT_MS = 250;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mcp_auth_failure_timeout")), ms);
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

export interface RecordMcpAuthFailureInput {
  kind: McpAuthFailureKind;
  orgId?: string | null;
  employeeId?: string | null;
  credentialId?: string | null;
  method?: string | null;
  /** Accepted only so callers can pass the header; NEVER forwarded to SQL. */
  presentedSecret?: string | null;
  fingerprint?: string | null;
}

export async function recordMcpAuthFailure(input: RecordMcpAuthFailureInput): Promise<void> {
  try {
    if (!isMcpAuthFailureAuditEnabled()) return;
    if (!KIND.has(input.kind)) return;
    if (isDemoMode()) return;
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    const method = typeof input.method === "string" && METHOD.test(input.method) ? input.method : null;
    await withTimeout(
      Promise.resolve(
        admin.rpc("record_mcp_auth_failure", {
          p_kind: input.kind,
          p_org_id: uuidOrNull(input.orgId),
          p_employee_id: uuidOrNull(input.employeeId),
          p_credential_id: uuidOrNull(input.credentialId),
          p_method: method,
        })
      ),
      MCP_AUTH_FAILURE_TIMEOUT_MS
    );
  } catch {
    // observation only
  }
}
