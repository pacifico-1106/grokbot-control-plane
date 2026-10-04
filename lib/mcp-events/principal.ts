/**
 * The subscription principal is the employee badge (gb_emp_) that subscribed:
 * org + employee + credential generation (+ fingerprint). Re-checked on EVERY
 * delivery attempt; a positively known change (binding revoked / row missing,
 * badge rotated / revoked / expired, employee suspended or moved) stops
 * delivery immediately — the server cannot rely on the client (ChatGPT has no
 * `terminated` support).
 *
 * Read errors are NOT "no row" (木村 review, 2026-10-05): the shared lib/data
 * getters swallow DB errors and return undefined / null, so this module reads
 * through its own strict reader. Any read error, missing service-role client
 * or thrown exception yields `kind: "unavailable"` (reason
 * revocation_check_unavailable): the caller defers the attempt and must not
 * revoke or drop anything. Only `kind: "revoked"` stops subscriptions.
 */
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { getBinding, getEmployeeById } from "@/lib/data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { SubscriptionRow } from "./store";

export function principalFor(cred: Pick<ResolvedEmployeeCredential, "orgId" | "employeeId" | "generation">): string {
  return `emp:${cred.orgId}:${cred.employeeId}:g${cred.generation}`;
}

export const REVOCATION_CHECK_UNAVAILABLE = "revocation_check_unavailable" as const;

export type PrincipalCheck =
  | { ok: true }
  | { ok: false; kind: "revoked"; reason: string }
  | { ok: false; kind: "unavailable"; reason: typeof REVOCATION_CHECK_UNAVAILABLE; detail: string };

export type Read<T> = { state: "found"; value: T } | { state: "missing" } | { state: "error"; detail: string };
export type BindingState = { orgId: string | null; status: string; credentialGeneration: number; credentialFingerprint: string | null };
export type EmployeeState = { orgId: string; status: string };
export type CredentialState = { revokedAt: string | null; expiresAt: string | null };
export type PrincipalReader = {
  binding(employeeId: string): Promise<Read<BindingState>>;
  employee(employeeId: string): Promise<Read<EmployeeState>>;
  credential(credentialId: string, employeeId: string): Promise<Read<CredentialState>>;
};

type MaybeSingle = { data: unknown; error: unknown };
const errorRead = (detail: string) => ({ state: "error" as const, detail });

async function strictRead<T>(run: () => PromiseLike<MaybeSingle> | null, map: (row: Record<string, unknown>) => T, what: string): Promise<Read<T>> {
  try {
    const pending = run();
    if (!pending) return errorRead("service_role_unavailable");
    const { data, error } = await pending;
    if (error) return errorRead(`${what}_read_error`);
    if (!data) return { state: "missing" };
    return { state: "found", value: map(data as Record<string, unknown>) };
  } catch {
    return errorRead(`${what}_read_threw`);
  }
}

/**
 * Production reader: service-role reads that keep "error" and "no row" apart
 * (a missing service-role client is an error too, never "no row").
 */
export function supabasePrincipalReader(): PrincipalReader {
  return {
    binding: (employeeId) => strictRead(
      () => {
        const db = createSupabaseAdminClient();
        return db ? db.from("employee_bindings").select("employee_id, org_id, status, credential_generation, credential_fingerprint").eq("employee_id", employeeId).maybeSingle() : null;
      },
      (r) => ({
        orgId: r.org_id === null || r.org_id === undefined ? null : String(r.org_id),
        status: String(r.status ?? ""),
        credentialGeneration: Number(r.credential_generation),
        credentialFingerprint: r.credential_fingerprint ? String(r.credential_fingerprint) : null,
      }),
      "binding"
    ),
    employee: (employeeId) => strictRead(
      () => {
        const db = createSupabaseAdminClient();
        return db ? db.from("employees").select("id, org_id, status").eq("id", employeeId).maybeSingle() : null;
      },
      (r) => ({ orgId: String(r.org_id ?? ""), status: String(r.status ?? "") }),
      "employee"
    ),
    credential: (credentialId, employeeId) => strictRead(
      () => {
        const db = createSupabaseAdminClient();
        return db ? db.from("credentials").select("revoked_at, expires_at").eq("id", credentialId).eq("employee_id", employeeId).maybeSingle() : null;
      },
      (r) => ({ revokedAt: r.revoked_at ? String(r.revoked_at) : null, expiresAt: r.expires_at ? String(r.expires_at) : null }),
      "credential"
    ),
  };
}

/** Demo reader: the in-memory stores cannot fail transiently; credentials have no rows in demo. */
function demoPrincipalReader(): PrincipalReader {
  return {
    binding: async (employeeId) => {
      const b = await getBinding(employeeId);
      return b
        ? { state: "found", value: { orgId: b.orgId ?? null, status: b.status, credentialGeneration: b.credentialGeneration, credentialFingerprint: b.credentialFingerprint ?? null } }
        : { state: "missing" };
    },
    employee: async (employeeId) => {
      const e = await getEmployeeById(employeeId);
      return e ? { state: "found", value: { orgId: e.orgId, status: e.status } } : { state: "missing" };
    },
    credential: async () => ({ state: "found", value: { revokedAt: null, expiresAt: null } }),
  };
}

let readerOverride: PrincipalReader | null = null;
export function __setPrincipalReaderForTests(r: PrincipalReader | null): void { readerOverride = r; }

export function defaultPrincipalReader(): PrincipalReader {
  return isDemoMode() ? demoPrincipalReader() : supabasePrincipalReader();
}

export async function checkSubscriptionPrincipal(
  sub: Pick<SubscriptionRow, "orgId" | "employeeId" | "credentialGeneration" | "credentialFingerprint" | "credentialId">,
  nowMs: number
): Promise<PrincipalCheck> {
  const unavailable = (detail: string): PrincipalCheck => ({ ok: false, kind: "unavailable", reason: REVOCATION_CHECK_UNAVAILABLE, detail });
  const revoked = (reason: string): PrincipalCheck => ({ ok: false, kind: "revoked", reason });
  try {
    const reader = readerOverride ?? defaultPrincipalReader();
    const binding = await reader.binding(sub.employeeId);
    if (binding.state === "error") return unavailable(binding.detail);
    if (binding.state === "missing") return revoked("binding_missing");
    const b = binding.value;
    if (b.orgId && b.orgId !== sub.orgId) return revoked("org_mismatch");
    if (b.status === "revoked") return revoked("binding_revoked");
    if (!Number.isFinite(b.credentialGeneration)) return unavailable("binding_generation_unreadable");
    if (b.credentialGeneration !== sub.credentialGeneration) return revoked("credential_rotated");
    if (b.credentialFingerprint && b.credentialFingerprint !== sub.credentialFingerprint) return revoked("credential_rotated");

    const employee = await reader.employee(sub.employeeId);
    if (employee.state === "error") return unavailable(employee.detail);
    if (employee.state === "missing") return revoked("employee_missing");
    if (employee.value.orgId !== sub.orgId) return revoked("employee_missing");
    if (employee.value.status === "suspended") return revoked("employee_suspended");

    if (sub.credentialId) {
      const cred = await reader.credential(sub.credentialId, sub.employeeId);
      if (cred.state === "error") return unavailable(cred.detail);
      if (cred.state === "missing") return revoked("credential_missing");
      if (cred.value.revokedAt) return revoked("credential_revoked");
      if (cred.value.expiresAt && Date.parse(cred.value.expiresAt) < nowMs) return revoked("credential_expired");
    }
    return { ok: true };
  } catch {
    return unavailable("check_threw");
  }
}
