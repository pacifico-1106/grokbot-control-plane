import {
  addRuntimeEmployee,
  DEMO_ORG,
  getRuntimeEmployees,
} from "../demo-data";
import { ensureBindingRow, rotateCredential } from "../bindings";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapEmployeeRow } from "./mappers";
import type { Employee } from "../types";

export async function listEmployees(orgId?: string | null): Promise<Employee[]> {
  if (isDemoMode()) {
    return getRuntimeEmployees();
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return [];

  const { data: employees, error } = await admin
    .from("employees")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error || !employees) return [];

  const { data: creds } = await admin
    .from("credentials")
    .select("id, employee_id")
    .eq("org_id", orgId)
    .is("revoked_at", null);

  const credByEmp = new Map<string, string>();
  for (const c of creds || []) {
    const row = c as { id: string; employee_id: string };
    if (!credByEmp.has(row.employee_id)) {
      credByEmp.set(row.employee_id, row.id);
    }
  }

  return employees.map((row) => {
    const mapped = mapEmployeeRow(row as Record<string, unknown>);
    mapped.credentialId = credByEmp.get(mapped.id) ?? null;
    return mapped;
  });
}

export async function getEmployee(
  id: string,
  orgId?: string | null
): Promise<Employee | null> {
  const all = await listEmployees(orgId);
  return all.find((e) => e.id === id) ?? null;
}

/**
 * Admin lookup by primary key (no org filter).
 * Used by Gateway Bot invokes that have x-employee-id but no browser session org.
 */
export async function getEmployeeById(id: string): Promise<Employee | null> {
  if (isDemoMode()) {
    return getRuntimeEmployees().find((e) => e.id === id) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("employees")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;

  const mapped = mapEmployeeRow(data as Record<string, unknown>);

  const { data: cred } = await admin
    .from("credentials")
    .select("id")
    .eq("employee_id", id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cred) {
    mapped.credentialId = String((cred as { id: string }).id);
  }
  return mapped;
}

export type IssueEmployeeInput = {
  orgId?: string | null;
  displayName: string;
  roleLabel: string;
  jobDescription?: string;
  scopes: Employee["scopes"];
  allowedPurposes: string[];
  approvalPolicy: Employee["approvalPolicy"];
  spend: Employee["spend"];
  allowedAccounts: Employee["allowedAccounts"];
  approvalNotifyEmail?: string | null;
  callbackUrl?: string | null;
  approvalRoutineText?: string | null;
  secretHash: string;
  secretPrefix: string;
  expiresAt: string | null;
  auditSummary: string;
};

export type IssueEmployeeResult = {
  employee: Employee;
  credentialId: string;
  binding: ReturnType<typeof rotateCredential>["binding"];
  generation: number;
  demo: boolean;
};

/**
 * Create employee + credential + binding generation bump.
 * DEMO: in-memory. Prod: Supabase admin (service role).
 */
export async function issueEmployee(
  input: IssueEmployeeInput
): Promise<IssueEmployeeResult> {
  if (isDemoMode()) {
    const { randomBytes } = await import("node:crypto");
    const employeeId = `emp_${randomBytes(4).toString("hex")}`;
    const credentialId = `cred_${randomBytes(4).toString("hex")}`;
    const employee: Employee = {
      id: employeeId,
      orgId: DEMO_ORG.id,
      displayName: input.displayName,
      roleLabel: input.roleLabel,
      jobDescription: input.jobDescription || "",
      status: "active",
      scopes: input.scopes,
      allowedPurposes: input.allowedPurposes,
      approvalPolicy: input.approvalPolicy,
      spend: input.spend,
      allowedAccounts: input.allowedAccounts ?? [],
      approvalNotifyEmail: input.approvalNotifyEmail ?? null,
      callbackUrl: input.callbackUrl ?? null,
      approvalRoutineText: input.approvalRoutineText ?? null,
      credentialId,
      createdAt: new Date().toISOString(),
    };
    addRuntimeEmployee(employee, input.auditSummary);
    const { binding, generation } = rotateCredential(
      employeeId,
      DEMO_ORG.id,
      input.secretHash
    );
    return { employee, credentialId, binding, generation, demo: true };
  }

  const admin = createSupabaseAdminClient();
  const orgId = input.orgId;
  if (!admin || !orgId) {
    throw new Error("supabase_not_configured");
  }

  const { data: empRow, error: empErr } = await admin
    .from("employees")
    .insert({
      org_id: orgId,
      display_name: input.displayName,
      role_label: input.roleLabel,
      job_description: input.jobDescription || "",
      status: "active",
      scopes: input.scopes,
      allowed_purposes: input.allowedPurposes,
      approval_policy: input.approvalPolicy,
      spend: input.spend ?? null,
      allowed_accounts: input.allowedAccounts ?? [],
      approval_notify_email: input.approvalNotifyEmail ?? null,
      callback_url: input.callbackUrl ?? null,
      approval_routine_text: input.approvalRoutineText ?? null,
    })
    .select("*")
    .single();

  if (empErr || !empRow) {
    throw new Error(empErr?.message || "employee_insert_failed");
  }

  const employeeId = String((empRow as { id: string }).id);

  const { data: credRow, error: credErr } = await admin
    .from("credentials")
    .insert({
      org_id: orgId,
      employee_id: employeeId,
      secret_hash: input.secretHash,
      secret_prefix: input.secretPrefix,
      scopes: input.scopes,
      allowed_purposes: input.allowedPurposes,
      approval_policy: input.approvalPolicy,
      spend: input.spend ?? null,
      allowed_accounts: input.allowedAccounts ?? [],
      expires_at: input.expiresAt,
    })
    .select("*")
    .single();

  if (credErr || !credRow) {
    throw new Error(credErr?.message || "credential_insert_failed");
  }

  const credentialId = String((credRow as { id: string }).id);

  await admin.from("employee_bindings").upsert({
    employee_id: employeeId,
    org_id: orgId,
    credential_generation: 1,
    credential_fingerprint: input.secretHash,
    status: "unlinked",
    updated_at: new Date().toISOString(),
  });

  await admin.from("audit_events").insert({
    org_id: orgId,
    employee_id: employeeId,
    credential_id: credentialId,
    action: "credential.issued",
    summary: input.auditSummary,
    metadata: {
      scopes: input.scopes,
      purposes: input.allowedPurposes,
      approvalPolicy: input.approvalPolicy,
      spend: input.spend ?? null,
      allowedAccounts: input.allowedAccounts ?? [],
    },
  });

  const { data: bindingRow } = await admin
    .from("employee_bindings")
    .select("*")
    .eq("employee_id", employeeId)
    .single();

  const employee = mapEmployeeRow({
    ...(empRow as Record<string, unknown>),
    credential_id: credentialId,
  });

  const { mapBindingRow } = await import("./mappers");
  const binding = bindingRow
    ? mapBindingRow(bindingRow as Record<string, unknown>)
    : ensureBindingRow(employeeId, orgId);

  return {
    employee,
    credentialId,
    binding,
    generation: binding.credentialGeneration,
    demo: false,
  };
}
