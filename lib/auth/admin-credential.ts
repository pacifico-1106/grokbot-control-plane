/**
 * Org admin credential for /api/mcp/admin.
 * NEVER accepts employee badges (gb_emp_). Fail closed.
 * Dedicated bearer prefix is gb_adm_ — do not share the employee MCP auth header.
 */
import { fingerprintSecret } from "@/lib/bindings";
import { findAdminAgentByFingerprint } from "@/lib/data/admin-agents";
import { ADMIN_CREDENTIAL_PREFIX } from "@/lib/mcp/admin-public";
import type { OrgAdminAgent } from "@/lib/types";

export type ResolvedAdminCredential = {
  orgId: string;
  adminAgentId: string;
  grokBotAgentId: string | null;
  actorId: string;
  generation: number;
  via: "bearer" | "session";
  agent: OrgAdminAgent;
};

export type AdminAuthFailure = {
  ok: false;
  code:
    | "missing_credential"
    | "invalid_credential"
    | "employee_badge_rejected"
    | "revoked"
    | "admin_required";
  message: string;
  httpStatus: number;
};

export type AdminAuthSuccess = { ok: true; credential: ResolvedAdminCredential };
export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

function extractRawSecret(req: Request): string | null {
  const headerCred = (req.headers.get("x-staffpass-admin-credential") || "").trim();
  if (headerCred) return headerCred;
  const auth = (req.headers.get("authorization") || "").trim();
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m?.[1]) return null;
  return m[1].trim();
}

export function isEmployeeBadgeSecret(raw: string): boolean {
  return raw.startsWith("gb_emp_");
}

export function isAdminSecret(raw: string): boolean {
  return raw.startsWith(ADMIN_CREDENTIAL_PREFIX);
}

export async function resolveAdminCredential(req: Request): Promise<AdminAuthResult> {
  const raw = extractRawSecret(req);
  if (raw) {
    if (isEmployeeBadgeSecret(raw)) {
      return {
        ok: false,
        code: "employee_badge_rejected",
        message:
          "employee badge (gb_emp_) is not valid on admin MCP (fail-closed). Use gb_adm_…",
        httpStatus: 401,
      };
    }
    if (!isAdminSecret(raw)) {
      return {
        ok: false,
        code: "invalid_credential",
        message: "credential must start with gb_adm_ (not an employee badge)",
        httpStatus: 401,
      };
    }
    const fingerprint = fingerprintSecret(raw);
    const agent = await findAdminAgentByFingerprint(fingerprint);
    if (!agent) {
      return {
        ok: false,
        code: "invalid_credential",
        message: "admin credential not found or rotated (fail-closed)",
        httpStatus: 401,
      };
    }
    if (agent.status === "revoked") {
      return {
        ok: false,
        code: "revoked",
        message: "admin credential revoked (fail-closed)",
        httpStatus: 403,
      };
    }
    return {
      ok: true,
      credential: {
        orgId: agent.orgId,
        adminAgentId: agent.id,
        grokBotAgentId: agent.grokBotAgentId,
        actorId: agent.id,
        generation: agent.credentialGeneration,
        via: "bearer",
        agent,
      },
    };
  }

  return {
    ok: false,
    code: "missing_credential",
    message:
      "Authorization: Bearer gb_adm_… is required (not gb_emp_ employee badge)",
    httpStatus: 401,
  };
}
