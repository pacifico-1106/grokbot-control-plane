import {
  addRuntimeEmployee,
  DEMO_ORG,
  getRuntimeEmployees,
} from "../demo-data";
import { ensureBindingRow, rotateCredential } from "../bindings";
import { revokeBinding } from "./bindings";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapEmployeeRow } from "./mappers";
import { evaluateSod } from "@/lib/employees/sod";
import { getOrgSodWarnPolicy } from "@/lib/data/org-context";
import { resolveApprovalPolicy } from "@/lib/employees/sod-override";
import { normalizeActionLimits } from "@/lib/action-gate";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { normalizeApproverUserIds } from "@/lib/employees/approval-inbox";
import type { ActionLimits, Employee, EmployeeProjectAccess, PostingAs } from "../types";
import { requireApprovalNotifyEmail } from "@/lib/employees/approval-notify-email";
import {
  ApproverContextWriteRefusedError,
  assertDemoContextUnchanged,
  assertGuardFor,
  casResult,
  employeePolicyProjection,
  type ApproverContextGuard,
} from "@/lib/approver-authority/context-cas";

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
  if (!id || !orgId) return null;
  const all = await listEmployees(orgId);
  return all.find((e) => e.id === id && e.orgId === orgId) ?? null;
}

/**
 * Admin lookup by primary key (no org filter).
 * Used by Gateway invokes authenticated by 社員証 (no browser session org).
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
  toolApprovalDefaults?: Employee["toolApprovalDefaults"];
  sodOverrideAcknowledged?: boolean;
  actionLimits?: ActionLimits;
  spend: Employee["spend"];
  allowedAccounts: Employee["allowedAccounts"];
  approvalNotifyEmail?: string | null;
  callbackUrl?: string | null;
  approvalRoutineText?: string | null;
  managerId?: string | null;
  voice?: Employee["voice"] | null;
  projectAccess?: EmployeeProjectAccess | null;
  postingAs?: PostingAs | null;
  approvalChannelId?: string | null;
  approverUserIds?: string[];
  secretHash: string;
  secretPrefix: string;
  expiresAt: string | null;
  auditSummary: string;
  /** Who issued (credential.issued audit). Never the secret. */
  actorEmail?: string | null;
  actorMemberId?: string | null;
};

/** 12-char hash prefix only — same shape as credential.rotated. */
function issueAuditIdentity(input: IssueEmployeeInput): Record<string, unknown> {
  return {
    secretHashPrefix: input.secretHash.slice(0, 12),
    actorMemberId: input.actorMemberId ?? null,
  };
}

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
  const sodVerdict = evaluateSod(input.scopes, await getOrgSodWarnPolicy(input.orgId));
  const effectivePolicy = resolveApprovalPolicy({
    verdict: sodVerdict,
    requested: input.approvalPolicy,
    acknowledged: input.sodOverrideAcknowledged,
  });
  const actionLimits = normalizeActionLimits(input.actionLimits);
  // Members-only recipient (2026-10-09): every caller of this writer is checked
  // here, whatever route it came from. Throws ApprovalNotifyEmailError.
  const approvalNotifyEmail = await requireApprovalNotifyEmail(
    isDemoMode() ? (input.orgId ?? DEMO_ORG.id) : input.orgId,
    input.approvalNotifyEmail
  );
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
      approvalPolicy: effectivePolicy,
      toolApprovalDefaults: normalizeToolApprovalDefaults(input.toolApprovalDefaults),
      sodLevel: sodVerdict.level,
      actionLimits,
      spend: input.spend,
      allowedAccounts: input.allowedAccounts ?? [],
      approvalNotifyEmail,
      callbackUrl: input.callbackUrl ?? null,
      approvalRoutineText: input.approvalRoutineText ?? null,
      managerId: input.managerId ?? null,
      voice: normalizeVoice(input.voice ?? defaultVoice()),
      projectAccess: normalizeProjectAccess(input.projectAccess ?? defaultProjectAccess()),
      postingAs: normalizePostingAs(input.postingAs),
      approvalChannelId: input.approvalChannelId?.trim() || null,
      approverUserIds: normalizeApproverUserIds(input.approverUserIds),
      credentialId,
      createdAt: new Date().toISOString(),
    };
    addRuntimeEmployee(employee, input.auditSummary, {
      ...issueAuditIdentity(input),
      actorEmail: input.actorEmail ?? null,
    });
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
      approval_policy: effectivePolicy,
      tool_approval_defaults: normalizeToolApprovalDefaults(input.toolApprovalDefaults),
      sod_level: sodVerdict.level,
      action_limits: actionLimits,
      spend: input.spend ?? null,
      allowed_accounts: input.allowedAccounts ?? [],
      approval_notify_email: approvalNotifyEmail,
      callback_url: input.callbackUrl ?? null,
      approval_routine_text: input.approvalRoutineText ?? null,
      manager_id: input.managerId ?? null,
      voice: normalizeVoice(input.voice ?? defaultVoice()),
      project_access: normalizeProjectAccess(input.projectAccess ?? defaultProjectAccess()),
      posting_as: normalizePostingAs(input.postingAs),
      approval_channel_id: input.approvalChannelId?.trim() || null,
      approver_user_ids: normalizeApproverUserIds(input.approverUserIds),
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
      approval_policy: effectivePolicy,
      action_limits: actionLimits,
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
    actor_email: input.actorEmail ?? null,
    action: "credential.issued",
    summary: input.auditSummary,
    metadata: {
      ...issueAuditIdentity(input),
      scopes: input.scopes,
      purposes: input.allowedPurposes,
      approvalPolicy: effectivePolicy,
      sodLevel: sodVerdict.level,
      actionLimits,
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

/**
 * Thrown by updateEmployeePolicy when a write fails (fail-closed: a failed
 * write is never reported as success, and a read/write error is never
 * reported as "employee not found"). `rolledBack` tells whether the employees
 * columns were put back after a credentials write failure. Same shape as
 * AllowedAccountsWriteError. Callers map it with employeePolicyWriteFailure()
 * (lib/employees/policy-errors.ts) and never show the storage detail.
 */
export class EmployeePolicyWriteError extends Error {
  readonly code: "employee_policy_update_failed" | "employee_policy_credentials_update_failed";
  readonly rolledBack: boolean;
  constructor(code: EmployeePolicyWriteError["code"], detail: string, rolledBack = false) {
    super(`${code}: ${detail}`);
    this.name = "EmployeePolicyWriteError";
    this.code = code;
    this.rolledBack = rolledBack;
  }
}

export async function updateEmployeePolicy(input: {
  orgId: string;
  employeeId: string;
  scopes: Employee["scopes"];
  /** undefined = keep the stored value ([] clears). */
  allowedPurposes?: string[];
  approvalPolicy: Employee["approvalPolicy"];
  toolApprovalDefaults?: Employee["toolApprovalDefaults"];
  sodOverrideAcknowledged?: boolean;
  /** undefined = keep the stored limits ({} clears). */
  actionLimits?: ActionLimits;
  allowedAccounts?: Employee["allowedAccounts"];
  spend?: Employee["spend"];
  managerId?: string | null;
  voice?: Employee["voice"];
  projectAccess?: EmployeeProjectAccess;
  postingAs?: PostingAs;
  displayName?: string;
  roleLabel?: string;
  approvalChannelId?: string | null;
  approverUserIds?: string[];
  /**
   * TOCTOU guard (APPROVER_AUTHORITY_ENABLED, approval-executed policy.patch):
   * write only if scopes / allowed_purposes / approval_policy / action_limits /
   * tool_approval_defaults still equal the pinned snapshot (production: one
   * RPC that locks, compares and writes employees + active credentials).
   * Mismatch → ApproverContextChangedError, nothing written. Only the
   * policy.patch fields may be written under a guard.
   */
  contextGuard?: ApproverContextGuard;
}): Promise<Employee | null> {
  const guard = input.contextGuard;
  if (guard) {
    assertGuardFor(guard, "policy.patch", input.employeeId);
    const unsupported = (["allowedAccounts", "spend", "managerId", "voice", "projectAccess", "postingAs", "displayName", "roleLabel",
      "approvalChannelId", "approverUserIds"] as const).filter((key) => input[key] !== undefined);
    if (unsupported.length) throw new ApproverContextWriteRefusedError("context_guard_unsupported_fields");
  }
  const verdict = evaluateSod(input.scopes, await getOrgSodWarnPolicy(input.orgId));
  const effectivePolicy = resolveApprovalPolicy({
    verdict,
    requested: input.approvalPolicy,
    acknowledged: input.sodOverrideAcknowledged,
  });
  // Omitted allowedPurposes / actionLimits keep the stored value (木村
  // 2026-10-05 / 2026-10-10, data loss since 30a631f): writing [] / {} would
  // remove every purpose restriction and limit, on employees AND the active
  // credentials row. Only an explicit value (incl. [] / {} = clear) is written.
  // Same rule as allowedAccounts / spend. purposesPatch / limitsPatch are the
  // non-guard path only; the guard path passes the RPC explicit values.
  const actionLimits = input.actionLimits === undefined ? undefined : normalizeActionLimits(input.actionLimits);
  const purposesPatch = input.allowedPurposes !== undefined ? { allowed_purposes: input.allowedPurposes } : {};
  const limitsPatch = actionLimits !== undefined ? { action_limits: actionLimits } : {};
  if (isDemoMode()) {
    const employee = getRuntimeEmployees().find((item) => item.id === input.employeeId && item.orgId === input.orgId);
    if (!employee) return null;
    // Compared right before the write (no await in between).
    if (guard) assertDemoContextUnchanged(guard, employeePolicyProjection(employee));
    Object.assign(employee, {
      scopes: input.scopes,
      ...(input.allowedPurposes !== undefined ? { allowedPurposes: input.allowedPurposes } : {}),
      approvalPolicy: effectivePolicy,
      ...(input.toolApprovalDefaults !== undefined
        ? { toolApprovalDefaults: normalizeToolApprovalDefaults(input.toolApprovalDefaults) }
        : {}),
      sodLevel: verdict.level,
      ...(actionLimits !== undefined ? { actionLimits } : {}),
      managerId: input.managerId === undefined ? employee.managerId : input.managerId,
      voice:
        input.voice === undefined
          ? (employee.voice ?? defaultVoice())
          : normalizeVoice(input.voice),
      projectAccess:
        input.projectAccess === undefined
          ? (employee.projectAccess ?? defaultProjectAccess())
          : normalizeProjectAccess(input.projectAccess),
      ...(input.postingAs !== undefined ? { postingAs: normalizePostingAs(input.postingAs) } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
      ...(input.roleLabel !== undefined ? { roleLabel: input.roleLabel.trim() } : {}),
      ...(input.allowedAccounts !== undefined ? { allowedAccounts: input.allowedAccounts } : {}),
      ...(input.spend !== undefined ? { spend: input.spend } : {}),
      ...(input.approvalChannelId !== undefined
        ? { approvalChannelId: input.approvalChannelId?.trim() || null }
        : {}),
      ...(input.approverUserIds !== undefined
        ? { approverUserIds: normalizeApproverUserIds(input.approverUserIds) }
        : {}),
    });
    return employee;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  if (guard) {
    // One transaction: lock the employee row, compare with the snapshot,
    // write employees + the active credentials, or refuse with nothing written.
    const { data, error } = await admin.rpc("approver_cas_write_employee_policy", {
      p_org: input.orgId,
      p_employee: input.employeeId,
      p_approval: guard.approvalId,
      p_fingerprint: guard.fingerprint,
      p_expected: guard.expected,
      p_scopes: input.scopes,
      p_allowed_purposes: input.allowedPurposes,
      p_approval_policy: effectivePolicy,
      p_tool_approval_defaults:
        input.toolApprovalDefaults !== undefined ? normalizeToolApprovalDefaults(input.toolApprovalDefaults) : null,
      p_sod_level: verdict.level,
      // An omitted actionLimits under the guard keeps the pinned value (the RPC
      // needs one; it equals the locked row whenever the write goes through).
      p_action_limits: actionLimits ?? normalizeActionLimits(guard.expected.action_limits as never),
    });
    const result = casResult(data, error);
    const row = result.employee;
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApproverContextWriteRefusedError("approver_context_cas_failed");
    return mapEmployeeRow(row as Record<string, unknown>);
  }
  const employeePatch: Record<string, unknown> = {
    scopes: input.scopes,
    ...purposesPatch,
    approval_policy: effectivePolicy,
    ...(input.toolApprovalDefaults !== undefined
      ? { tool_approval_defaults: normalizeToolApprovalDefaults(input.toolApprovalDefaults) }
      : {}),
    sod_level: verdict.level,
    ...limitsPatch,
    ...(input.managerId !== undefined ? { manager_id: input.managerId } : {}),
    ...(input.voice !== undefined ? { voice: normalizeVoice(input.voice) } : {}),
    ...(input.projectAccess !== undefined
      ? { project_access: normalizeProjectAccess(input.projectAccess) }
      : {}),
    ...(input.postingAs !== undefined ? { posting_as: normalizePostingAs(input.postingAs) } : {}),
    ...(input.displayName !== undefined ? { display_name: input.displayName.trim() } : {}),
    ...(input.roleLabel !== undefined ? { role_label: input.roleLabel.trim() } : {}),
    ...(input.allowedAccounts !== undefined ? { allowed_accounts: input.allowedAccounts } : {}),
    ...(input.spend !== undefined ? { spend: input.spend } : {}),
    ...(input.approvalChannelId !== undefined
      ? { approval_channel_id: input.approvalChannelId?.trim() || null }
      : {}),
    ...(input.approverUserIds !== undefined
      ? { approver_user_ids: normalizeApproverUserIds(input.approverUserIds) }
      : {}),
  };
  const columns = Object.keys(employeePatch);
  // Previous values (org-scoped) of exactly the columns written below, so a
  // failed credentials write can be undone.
  const { data: current, error: readError } = await admin
    .from("employees")
    .select(columns.join(","))
    .eq("id", input.employeeId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (readError) {
    throw new EmployeePolicyWriteError("employee_policy_update_failed", readError.message || "read_failed");
  }
  if (!current) return null;
  const currentRow = current as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(columns.map((column) => [column, currentRow[column] ?? null]));
  const { data, error } = await admin
    .from("employees")
    .update({ ...employeePatch, updated_at: new Date().toISOString() })
    .eq("id", input.employeeId)
    .eq("org_id", input.orgId)
    .select("*")
    .maybeSingle();
  if (error) {
    throw new EmployeePolicyWriteError("employee_policy_update_failed", error.message || "employees_update_failed");
  }
  if (!data) return null;
  let credentialsError: { message?: string } | null = null;
  try {
    const { error: updateError } = await admin
      .from("credentials")
      .update({
        scopes: input.scopes,
        ...purposesPatch,
        approval_policy: effectivePolicy,
        ...limitsPatch,
        ...(input.allowedAccounts !== undefined ? { allowed_accounts: input.allowedAccounts } : {}),
        ...(input.spend !== undefined ? { spend: input.spend } : {}),
      })
      .eq("employee_id", input.employeeId)
      .eq("org_id", input.orgId)
      .is("revoked_at", null);
    credentialsError = updateError ?? null;
  } catch (thrown) {
    credentialsError = { message: thrown instanceof Error ? thrown.message : "credentials_update_threw" };
  }
  if (credentialsError) {
    // Never leave employees and the active badge disagreeing: put employees back.
    let rolledBack = false;
    try {
      const { error: rollbackError } = await admin
        .from("employees")
        .update({ ...previous, updated_at: new Date().toISOString() })
        .eq("id", input.employeeId)
        .eq("org_id", input.orgId);
      rolledBack = !rollbackError;
    } catch {
      rolledBack = false;
    }
    throw new EmployeePolicyWriteError(
      "employee_policy_credentials_update_failed",
      credentialsError.message || "credentials_update_failed",
      rolledBack
    );
  }
  return mapEmployeeRow(data as Record<string, unknown>);
}

/**
 * Replace ONLY allowedAccounts on an employee badge (same storage as the
 * dashboard PATCH /api/employees/[id]/policy → updateEmployeePolicy:
 * employees.allowed_accounts + the active credentials row). Org-scoped:
 * returns null when the employee is not in `orgId`. Callers validate and
 * normalize (normalizeAllowedAccounts) before calling.
 */
/**
 * Thrown by updateEmployeeAllowedAccounts when a write fails (fail-closed: a
 * failed write is never reported as success). `rolledBack` tells whether
 * employees.allowed_accounts was put back after a credentials write failure.
 */
export class AllowedAccountsWriteError extends Error {
  readonly code: "allowed_accounts_update_failed" | "allowed_accounts_credentials_update_failed";
  readonly rolledBack: boolean;
  constructor(code: AllowedAccountsWriteError["code"], detail: string, rolledBack = false) {
    super(`${code}: ${detail}`);
    this.name = "AllowedAccountsWriteError";
    this.code = code;
    this.rolledBack = rolledBack;
  }
}

export async function updateEmployeeAllowedAccounts(input: {
  orgId: string;
  employeeId: string;
  allowedAccounts: NonNullable<Employee["allowedAccounts"]>;
}): Promise<Employee | null> {
  const orgId = input.orgId?.trim();
  const employeeId = input.employeeId?.trim();
  if (!orgId || !employeeId) return null;
  if (isDemoMode()) {
    const employee = getRuntimeEmployees().find((item) => item.id === employeeId && item.orgId === orgId);
    if (!employee) return null;
    employee.allowedAccounts = input.allowedAccounts.map((row) => ({ ...row }));
    return employee;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  // Previous value (org-scoped) so a failed credentials write can be undone.
  const { data: current, error: readError } = await admin
    .from("employees")
    .select("allowed_accounts")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) throw new AllowedAccountsWriteError("allowed_accounts_update_failed", readError.message || "read_failed");
  if (!current) return null;
  const previous = (current as { allowed_accounts?: unknown }).allowed_accounts ?? [];
  const { data, error } = await admin
    .from("employees")
    .update({ allowed_accounts: input.allowedAccounts, updated_at: new Date().toISOString() })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .maybeSingle();
  if (error) throw new AllowedAccountsWriteError("allowed_accounts_update_failed", error.message || "employees_update_failed");
  if (!data) return null;
  const { error: credentialsError } = await admin
    .from("credentials")
    .update({ allowed_accounts: input.allowedAccounts })
    .eq("employee_id", employeeId)
    .eq("org_id", orgId)
    .is("revoked_at", null);
  if (credentialsError) {
    // Never leave employees and the active badge disagreeing: put employees back.
    const { error: rollbackError } = await admin
      .from("employees")
      .update({ allowed_accounts: previous, updated_at: new Date().toISOString() })
      .eq("id", employeeId)
      .eq("org_id", orgId);
    throw new AllowedAccountsWriteError(
      "allowed_accounts_credentials_update_failed",
      credentialsError.message || "credentials_update_failed",
      !rollbackError
    );
  }
  return mapEmployeeRow(data as Record<string, unknown>);
}

export async function terminateEmployee(input: {
  orgId: string;
  employeeId: string;
}): Promise<Employee | null> {
  const orgId = input.orgId?.trim();
  const employeeId = input.employeeId?.trim();
  if (!orgId || !employeeId) return null;

  if (isDemoMode()) {
    const employee = getRuntimeEmployees().find(
      (item) => item.id === employeeId && item.orgId === orgId
    );
    if (!employee) return null;
    Object.assign(employee, { status: "suspended" as const });
    await revokeBinding(employeeId);
    return employee;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("employees")
    .update({
      status: "suspended",
      updated_at: now,
    })
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .select("*")
    .maybeSingle();
  if (error || !data) return null;

  await admin
    .from("credentials")
    .update({ revoked_at: now })
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .is("revoked_at", null);

  await revokeBinding(employeeId);
  const mapped = mapEmployeeRow(data as Record<string, unknown>);
  mapped.credentialId = null;
  return mapped;
}

