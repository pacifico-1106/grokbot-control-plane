/**
 * Shared employee badge (gb_emp_…) resolver for Gateway + remote MCP.
 * Fail-closed: unknown / revoked / expired / rotated-away secrets never soft-pass.
 */
import { fingerprintSecret } from "@/lib/bindings";
import { checkOperable, type HoldDenyCode } from "@/lib/safety/hold";
import {
  findBindingByCredentialFingerprint,
  getBinding,
  getEmployeeById,
} from "@/lib/data";
import { touchCredentialLastUsed } from "@/lib/data/credential-last-used";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { EmployeeBinding } from "@/lib/types";

/** mintOneTimeSecret stores raw.slice(0, 14). Default column 'gb_emp_' is not identifying. */
export const EMPLOYEE_SECRET_NONSECRET_PREFIX_LEN = 14;

export type ResolvedEmployeeCredential = {
  employeeId: string;
  orgId: string;
  generation: number;
  credentialId: string | null;
  fingerprint: string;
  binding: EmployeeBinding | null;
  secretPrefix: string;
};

export type CredentialAuthFailure = {
  ok: false;
  code:
    | "missing_credential"
    | "invalid_credential"
    | "revoked"
    | "expired"
    | "employee_not_found"
    | "employee_on_hold"
    | "org_on_hold"
    | "hold_state_unavailable";
  message: string;
  httpStatus: number;
  /** When resolvable without storing the token or its hash. */
  orgId?: string;
  employeeId?: string;
  credentialId?: string;
};

type AuthFailureIdentity = Pick<CredentialAuthFailure, "orgId" | "employeeId" | "credentialId">;

export type CredentialAuthSuccess = {
  ok: true;
  credential: ResolvedEmployeeCredential;
};

export type CredentialAuthResult = CredentialAuthSuccess | CredentialAuthFailure;

/** Extract raw secret from Authorization Bearer or x-staffpass-credential. */
export function extractEmployeeSecret(req: Request): string | null {
  const headerCred = (req.headers.get("x-staffpass-credential") || "").trim();
  if (headerCred) return headerCred;

  const auth = (req.headers.get("authorization") || "").trim();
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m?.[1]) return null;
  return m[1].trim();
}

function isGbEmpSecret(raw: string): boolean {
  return raw.startsWith("gb_emp_");
}

function identityFrom(
  orgId?: string | null,
  employeeId?: string | null,
  credentialId?: string | null
): AuthFailureIdentity {
  return {
    ...(orgId ? { orgId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(credentialId ? { credentialId } : {}),
  };
}

/** Non-secret key prefix lookup (minted slice(0, 14)). At most one live row. */
async function lookupByNonSecretPrefix(raw: string): Promise<AuthFailureIdentity | undefined> {
  if (raw.length < EMPLOYEE_SECRET_NONSECRET_PREFIX_LEN) return undefined;
  const prefix = raw.slice(0, EMPLOYEE_SECRET_NONSECRET_PREFIX_LEN);
  if (prefix === "gb_emp_") return undefined;
  const admin = createSupabaseAdminClient();
  if (!admin) return undefined;
  const { data } = await admin
    .from("credentials")
    .select("id, org_id, employee_id")
    .eq("secret_prefix", prefix)
    .is("revoked_at", null)
    .limit(2);
  const list = (Array.isArray(data) ? data : data ? [data] : []) as Array<{
    id: string;
    org_id: string;
    employee_id: string;
  }>;
  if (list.length !== 1) return undefined;
  return identityFrom(list[0].org_id, list[0].employee_id, list[0].id);
}

async function lookupProdByHash(
  hash: string,
  raw: string
): Promise<
  | { ok: true; value: ResolvedEmployeeCredential }
  | { ok: false; code: "invalid_credential" | "revoked" | "expired" } & AuthFailureIdentity
> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "invalid_credential" };

  // Prefer current binding fingerprint (survives rotate even if credentials row lags).
  const byFingerprint = await findBindingByCredentialFingerprint(hash);
  if (byFingerprint) {
    if (byFingerprint.status === "revoked") {
      return { ok: false, code: "revoked", ...identityFrom(byFingerprint.orgId, byFingerprint.employeeId) };
    }
    const { data: cred } = await admin
      .from("credentials")
      .select("id, secret_prefix, expires_at, revoked_at")
      .eq("employee_id", byFingerprint.employeeId)
      .eq("secret_hash", hash)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const credRow = cred as
      | {
          id: string;
          secret_prefix: string;
          expires_at: string | null;
          revoked_at: string | null;
        }
      | null;

    if (credRow?.expires_at && Date.parse(credRow.expires_at) < Date.now()) {
      return {
        ok: false,
        code: "expired",
        ...identityFrom(byFingerprint.orgId, byFingerprint.employeeId, credRow.id),
      };
    }

    return {
      ok: true,
      value: {
        employeeId: byFingerprint.employeeId,
        orgId: byFingerprint.orgId,
        generation: byFingerprint.credentialGeneration,
        credentialId: credRow?.id ?? null,
        fingerprint: hash,
        binding: byFingerprint,
        secretPrefix: credRow?.secret_prefix || "gb_emp_",
      },
    };
  }

  // Fallback: credentials.secret_hash — reject if binding fingerprint moved on.
  const { data: cred } = await admin
    .from("credentials")
    .select("id, org_id, employee_id, secret_prefix, expires_at, revoked_at")
    .eq("secret_hash", hash)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cred) {
    const byPrefix = await lookupByNonSecretPrefix(raw);
    return { ok: false, code: "invalid_credential", ...byPrefix };
  }

  const row = cred as {
    id: string;
    org_id: string;
    employee_id: string;
    secret_prefix: string;
    expires_at: string | null;
    revoked_at: string | null;
  };

  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { ok: false, code: "expired", ...identityFrom(row.org_id, row.employee_id, row.id) };
  }

  const binding = await getBinding(row.employee_id);
  if (binding?.status === "revoked") {
    return { ok: false, code: "revoked", ...identityFrom(row.org_id, row.employee_id, row.id) };
  }
  if (
    binding?.credentialFingerprint &&
    binding.credentialFingerprint !== hash
  ) {
    // Rotated away — old secret must not work. Ids from the old row (id lookup).
    return { ok: false, code: "invalid_credential", ...identityFrom(row.org_id, row.employee_id, row.id) };
  }

  return {
    ok: true,
    value: {
      employeeId: row.employee_id,
      orgId: row.org_id,
      generation: binding?.credentialGeneration ?? 0,
      credentialId: row.id,
      fingerprint: hash,
      binding: binding ?? null,
      secretPrefix: row.secret_prefix || "gb_emp_",
    },
  };
}

async function lookupDemoByHash(
  hash: string
): Promise<
  | { ok: true; value: ResolvedEmployeeCredential }
  | { ok: false; code: "invalid_credential" | "revoked" }
> {
  const binding = await findBindingByCredentialFingerprint(hash);
  if (!binding) return { ok: false, code: "invalid_credential" };
  if (binding.status === "revoked") return { ok: false, code: "revoked" };
  const employee = await getEmployeeById(binding.employeeId);
  if (!employee) return { ok: false, code: "invalid_credential" };
  return {
    ok: true,
    value: {
      employeeId: binding.employeeId,
      orgId: binding.orgId || employee.orgId,
      generation: binding.credentialGeneration,
      credentialId: employee.credentialId,
      fingerprint: hash,
      binding,
      secretPrefix: "gb_emp_",
    },
  };
}

/**
 * Resolve Bearer gb_emp_… (or x-staffpass-credential) to employee + org.
 * Does not check binding executability — callers use assertExecutable separately.
 */
export async function resolveEmployeeCredential(
  req: Request
): Promise<CredentialAuthResult> {
  const raw = extractEmployeeSecret(req);
  if (!raw) {
    return {
      ok: false,
      code: "missing_credential",
      message:
        "Authorization: Bearer gb_emp_… (or x-staffpass-credential) is required",
      httpStatus: 401,
    };
  }
  if (!isGbEmpSecret(raw)) {
    return {
      ok: false,
      code: "invalid_credential",
      message: "credential must start with gb_emp_",
      httpStatus: 401,
    };
  }

  const fingerprint = fingerprintSecret(raw);
  const looked = isDemoMode()
    ? await lookupDemoByHash(fingerprint)
    : await lookupProdByHash(fingerprint, raw);

  if (!looked.ok) {
    const messages: Record<string, string> = {
      invalid_credential: "credential not found or rotated (fail-closed)",
      revoked: "credential / binding revoked (fail-closed)",
      expired: "credential expired (fail-closed)",
    };
    const httpStatus = looked.code === "revoked" ? 403 : 401;
    return {
      ok: false,
      code: looked.code,
      message: messages[looked.code] || messages.invalid_credential,
      httpStatus,
      ...identityFrom(
        "orgId" in looked ? looked.orgId : undefined,
        "employeeId" in looked ? looked.employeeId : undefined,
        "credentialId" in looked ? looked.credentialId : undefined
      ),
    };
  }

  const resolved = looked.value;
  if (resolved.binding?.status === "revoked") {
    return {
      ok: false,
      code: "revoked",
      message: "credential / binding revoked (fail-closed)",
      httpStatus: 403,
      ...identityFrom(resolved.orgId, resolved.employeeId, resolved.credentialId),
    };
  }

  const employee = await getEmployeeById(resolved.employeeId);
  if (!employee || employee.status === "suspended") {
    return {
      ok: false,
      code: "employee_not_found",
      message: "employee not found or suspended (fail-closed)",
      httpStatus: 401,
      ...identityFrom(resolved.orgId, resolved.employeeId, resolved.credentialId),
    };
  }

  // S2 G1 (emergency stop, no flag): the badge stays valid, but a held employee / org
  // (or an unreadable hold state) is refused on every request. Fail-stop.
  const operable = await checkOperable({ orgId: resolved.orgId || employee.orgId, employeeId: resolved.employeeId, phase: "credential" });
  if (!operable.ok) return holdRefusal(operable.code);

  void touchCredentialLastUsed(resolved.credentialId);
  return { ok: true, credential: resolved };
}

export function holdRefusal(code: HoldDenyCode): CredentialAuthFailure {
  return code === "hold_state_unavailable"
    ? { ok: false, code, message: "hold state unavailable; refused (fail-stop)", httpStatus: 503 }
    : { ok: false, code, message: code === "org_on_hold" ? "organization is on emergency stop" : "employee is on hold (emergency stop / leave)", httpStatus: 403 };
}
