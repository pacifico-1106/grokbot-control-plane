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
import { demoGetOverlapCredentialByHash } from "@/lib/data/credential-renewals";
import {
  completeCredentialOverlapOnFirstAuth,
  overlapNewCredentialAllowed,
} from "@/lib/employees/credential-auto-renew-overlap";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { EmployeeBinding } from "@/lib/types";

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
    | "hold_state_unavailable"
    | "employee_terminated";
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

async function lookupProdByHash(
  hash: string
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

  if (!cred) return { ok: false, code: "invalid_credential" };

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
    const overlapOk = await overlapNewCredentialAllowed({
      orgId: row.org_id,
      newCredentialId: row.id,
      bindingFingerprint: binding.credentialFingerprint,
    });
    if (!overlapOk) {
      // Rotated away — old secret must not work. Ids from the old row (id lookup).
      return { ok: false, code: "invalid_credential", ...identityFrom(row.org_id, row.employee_id, row.id) };
    }
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
  | { ok: false; code: "invalid_credential" | "revoked" | "expired" }
> {
  const binding = await findBindingByCredentialFingerprint(hash);
  if (binding) {
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
  const overlapCred = demoGetOverlapCredentialByHash(hash);
  if (!overlapCred || overlapCred.revokedAt) return { ok: false, code: "invalid_credential" };
  if (overlapCred.expiresAt && Date.parse(overlapCred.expiresAt) < Date.now()) {
    return { ok: false, code: "expired" };
  }
  const liveBinding = await getBinding(overlapCred.employeeId);
  if (liveBinding?.status === "revoked") return { ok: false, code: "revoked" };
  const overlapOk = await overlapNewCredentialAllowed({
    orgId: overlapCred.orgId,
    newCredentialId: overlapCred.id,
    bindingFingerprint: liveBinding?.credentialFingerprint,
  });
  if (!overlapOk) return { ok: false, code: "invalid_credential" };
  const employee = await getEmployeeById(overlapCred.employeeId);
  if (!employee) return { ok: false, code: "invalid_credential" };
  return {
    ok: true,
    value: {
      employeeId: overlapCred.employeeId,
      orgId: overlapCred.orgId || employee.orgId,
      generation: liveBinding?.credentialGeneration ?? 0,
      credentialId: overlapCred.id,
      fingerprint: hash,
      binding: liveBinding ?? null,
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
    : await lookupProdByHash(fingerprint);

  if (!looked.ok) {
    const messages: Record<string, string> = {
      invalid_credential: "credential not found or rotated (fail-closed)",
      revoked: "credential / binding revoked (fail-closed)",
      expired: "credential expired (fail-closed)",
    };
    const httpStatus = looked.code === "revoked" ? 403 : 401;
    const failId = looked as AuthFailureIdentity;
    return {
      ok: false,
      code: looked.code,
      message: messages[looked.code] || messages.invalid_credential,
      httpStatus,
      ...identityFrom(failId.orgId, failId.employeeId, failId.credentialId),
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
  await completeCredentialOverlapOnFirstAuth({
    orgId: resolved.orgId,
    employeeId: resolved.employeeId,
    credentialId: resolved.credentialId,
    fingerprint: resolved.fingerprint,
  }).catch(() => undefined);
  return { ok: true, credential: resolved };
}

export function holdRefusal(code: HoldDenyCode): CredentialAuthFailure {
  if (code === "hold_state_unavailable") {
    return { ok: false, code, message: "hold state unavailable; refused (fail-stop)", httpStatus: 503 };
  }
  if (code === "employee_terminated") {
    return { ok: false, code, message: "employee is retired (contract ended)", httpStatus: 403 };
  }
  return { ok: false, code, message: code === "org_on_hold" ? "organization is on emergency stop" : "employee is on hold (emergency stop / leave)", httpStatus: 403 };
}
