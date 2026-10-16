/**
 * MCP_AUTH_FAILURE_AUDIT_ENABLED (default OFF): record /api/mcp auth failures.
 * Production: public.record_mcp_auth_failure (migration 20261016200000) —
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
    await admin.rpc("record_mcp_auth_failure", {
      p_kind: input.kind,
      p_org_id: uuidOrNull(input.orgId),
      p_employee_id: uuidOrNull(input.employeeId),
      p_credential_id: uuidOrNull(input.credentialId),
      p_method: method,
    });
  } catch {
    // observation only
  }
}
