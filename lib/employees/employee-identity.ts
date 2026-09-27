/**
 * P0-ID: Employee identity binding management.
 *
 * Maps AI employees to responsible humans within an org for:
 * - Business approvals routing (P0-IN)
 * - Mailbox ownership / inbox access
 * - Audit and compliance reporting
 *
 * Security invariants:
 * - One binding per employee per org (composite unique)
 * - Cross-org binding prohibited (RLS enforced)
 * - Mailbox binding requires always_human approval
 * - No hardcoded org IDs
 */

import { randomBytes } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isEmployeeIdentityEnabled } from "@/lib/feature-flags";
import type { EmployeeIdentityBinding, EmployeeIdentityStatus } from "@/lib/types";

const IDENTITY_BINDING_ID_PREFIX = "eib_";

export interface CreateIdentityBindingInput {
  orgId: string;
  employeeId: string;
  responsibleMemberId: string;
  mailboxId?: string | null;
}

export interface UpdateIdentityBindingInput {
  orgId: string;
  employeeId: string;
  responsibleMemberId?: string;
  mailboxId?: string | null;
  status?: EmployeeIdentityStatus;
}

export interface BindMailboxInput {
  orgId: string;
  employeeId: string;
  mailboxId: string;
}

export interface IdentityBindingResult {
  ok: true;
  binding: EmployeeIdentityBinding;
}

export interface IdentityBindingError {
  ok: false;
  code: string;
  messageJa: string;
}

type DemoBinding = EmployeeIdentityBinding;
const demoBindings = new Map<string, DemoBinding>();

function generateBindingId(): string {
  return IDENTITY_BINDING_ID_PREFIX + randomBytes(12).toString("hex");
}

function bindingKey(orgId: string, employeeId: string): string {
  return `${orgId}:${employeeId}`;
}

export function checkFeatureEnabled(): IdentityBindingError | null {
  if (!isEmployeeIdentityEnabled()) {
    return {
      ok: false,
      code: "feature_disabled",
      messageJa: "従業員アイデンティティ機能は無効です。P0_EMPLOYEE_IDENTITY_ENABLED=true で有効化してください。",
    };
  }
  return null;
}

export async function checkMemberBelongsToOrg(
  memberId: string,
  orgId: string
): Promise<{ ok: boolean; reason?: string }> {
  if (isDemoMode()) {
    const { getRuntimeMemberById } = await import("@/lib/demo-data");
    const member = getRuntimeMemberById(memberId);
    if (!member) return { ok: false, reason: "member_not_found" };
    if (member.orgId !== orgId) return { ok: false, reason: "cross_org_member" };
    if (member.status !== "active") return { ok: false, reason: "member_not_active" };
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "supabase_unavailable" };

  const { data, error } = await admin
    .from("org_members")
    .select("id, org_id, status")
    .eq("id", memberId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "member_not_found" };
  if (data.status !== "active") return { ok: false, reason: "member_not_active" };
  return { ok: true };
}

export async function checkEmployeeBelongsToOrg(
  employeeId: string,
  orgId: string
): Promise<{ ok: boolean; reason?: string }> {
  if (isDemoMode()) {
    const { getEmployeeById } = await import("@/lib/data/employees");
    const employee = await getEmployeeById(employeeId);
    if (!employee) return { ok: false, reason: "employee_not_found" };
    if (employee.orgId !== orgId) return { ok: false, reason: "cross_org_employee" };
    return { ok: true };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "supabase_unavailable" };

  const { data, error } = await admin
    .from("employees")
    .select("id, org_id, status")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "employee_not_found" };
  return { ok: true };
}

export async function getIdentityBinding(
  orgId: string,
  employeeId: string
): Promise<EmployeeIdentityBinding | null> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) return null;

  if (isDemoMode()) {
    return demoBindings.get(bindingKey(orgId, employeeId)) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("employee_identity_bindings")
    .select("*")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .maybeSingle();

  if (error || !data) return null;
  return mapBindingRow(data as Record<string, unknown>);
}

export async function listIdentityBindings(
  orgId: string,
  options?: { includeRevoked?: boolean }
): Promise<EmployeeIdentityBinding[]> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) return [];

  if (isDemoMode()) {
    return Array.from(demoBindings.values())
      .filter((b) => {
        if (b.orgId !== orgId) return false;
        if (!options?.includeRevoked && b.status === "revoked") return false;
        return true;
      });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  let query = admin
    .from("employee_identity_bindings")
    .select("*")
    .eq("org_id", orgId);

  if (!options?.includeRevoked) {
    query = query.neq("status", "revoked");
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error || !data) return [];

  return data.map((row) => mapBindingRow(row as Record<string, unknown>));
}

export async function upsertIdentityBinding(
  input: CreateIdentityBindingInput
): Promise<IdentityBindingResult | IdentityBindingError> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) return featureCheck;

  const memberCheck = await checkMemberBelongsToOrg(input.responsibleMemberId, input.orgId);
  if (!memberCheck.ok) {
    return {
      ok: false,
      code: memberCheck.reason || "cross_org_invariant_violated",
      messageJa: memberCheck.reason === "member_not_found"
        ? "指定されたメンバーが見つかりません。"
        : memberCheck.reason === "member_not_active"
          ? "指定されたメンバーは無効化されています。"
          : "メンバーはこの組織に所属していません（クロスオルグ違反）。",
    };
  }

  const employeeCheck = await checkEmployeeBelongsToOrg(input.employeeId, input.orgId);
  if (!employeeCheck.ok) {
    return {
      ok: false,
      code: employeeCheck.reason || "employee_not_in_org",
      messageJa: employeeCheck.reason === "employee_not_found"
        ? "指定されたAI社員が見つかりません。"
        : "AI社員はこの組織に所属していません（クロスオルグ違反）。",
    };
  }

  const now = new Date().toISOString();

  if (isDemoMode()) {
    const key = bindingKey(input.orgId, input.employeeId);
    const existing = demoBindings.get(key);
    const binding: DemoBinding = {
      id: existing?.id || generateBindingId(),
      orgId: input.orgId,
      employeeId: input.employeeId,
      responsibleMemberId: input.responsibleMemberId,
      mailboxId: input.mailboxId ?? existing?.mailboxId ?? null,
      status: "active",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      revokedAt: null,
      revokedBy: null,
    };
    demoBindings.set(key, binding);
    return { ok: true, binding };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, code: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const { data, error } = await admin
    .from("employee_identity_bindings")
    .upsert(
      {
        org_id: input.orgId,
        employee_id: input.employeeId,
        responsible_member_id: input.responsibleMemberId,
        mailbox_id: input.mailboxId ?? null,
        status: "active",
        updated_at: now,
        revoked_at: null,
        revoked_by: null,
      },
      { onConflict: "org_id,employee_id" }
    )
    .select("*")
    .maybeSingle();

  if (error || !data) {
    console.error("employee_identity_upsert_failed", { error, input });
    return { ok: false, code: "upsert_failed", messageJa: "アイデンティティバインディングの作成/更新に失敗しました。" };
  }

  return { ok: true, binding: mapBindingRow(data as Record<string, unknown>) };
}

export async function bindMailbox(
  input: BindMailboxInput
): Promise<IdentityBindingResult | IdentityBindingError> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) return featureCheck;

  const existing = await getIdentityBinding(input.orgId, input.employeeId);
  if (!existing) {
    return {
      ok: false,
      code: "binding_not_found",
      messageJa: "AI社員のアイデンティティバインディングが見つかりません。先にemployeeIdentity.upsertで作成してください。",
    };
  }

  if (existing.status === "revoked") {
    return {
      ok: false,
      code: "binding_revoked",
      messageJa: "このバインディングは取り消されています。",
    };
  }

  const now = new Date().toISOString();

  if (isDemoMode()) {
    const key = bindingKey(input.orgId, input.employeeId);
    const updated: DemoBinding = {
      ...existing,
      mailboxId: input.mailboxId,
      updatedAt: now,
    };
    demoBindings.set(key, updated);
    return { ok: true, binding: updated };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, code: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const { data, error } = await admin
    .from("employee_identity_bindings")
    .update({
      mailbox_id: input.mailboxId,
      updated_at: now,
    })
    .eq("org_id", input.orgId)
    .eq("employee_id", input.employeeId)
    .neq("status", "revoked")
    .select("*")
    .maybeSingle();

  if (error || !data) {
    console.error("employee_identity_bind_mailbox_failed", { error, input });
    return { ok: false, code: "bind_mailbox_failed", messageJa: "メールボックスのバインドに失敗しました。" };
  }

  return { ok: true, binding: mapBindingRow(data as Record<string, unknown>) };
}

export async function revokeIdentityBinding(
  orgId: string,
  employeeId: string,
  revokedBy: string
): Promise<IdentityBindingResult | IdentityBindingError> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) return featureCheck;

  const existing = await getIdentityBinding(orgId, employeeId);
  if (!existing) {
    return {
      ok: false,
      code: "binding_not_found",
      messageJa: "バインディングが見つかりません。",
    };
  }

  const now = new Date().toISOString();

  if (isDemoMode()) {
    const key = bindingKey(orgId, employeeId);
    const updated: DemoBinding = {
      ...existing,
      status: "revoked",
      revokedAt: now,
      revokedBy,
      updatedAt: now,
    };
    demoBindings.set(key, updated);
    return { ok: true, binding: updated };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, code: "supabase_unavailable", messageJa: "データベースに接続できません。" };
  }

  const { data, error } = await admin
    .from("employee_identity_bindings")
    .update({
      status: "revoked",
      revoked_at: now,
      revoked_by: revokedBy,
      updated_at: now,
    })
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .select("*")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, code: "revoke_failed", messageJa: "バインディングの取り消しに失敗しました。" };
  }

  return { ok: true, binding: mapBindingRow(data as Record<string, unknown>) };
}

export async function getIdentityBindingStatus(
  orgId: string
): Promise<{
  enabled: boolean;
  totalBindings: number;
  activeBindings: number;
  pendingBindings: number;
  revokedBindings: number;
  messageJa: string;
  nextStepJa: string;
}> {
  const featureCheck = checkFeatureEnabled();
  if (featureCheck) {
    return {
      enabled: false,
      totalBindings: 0,
      activeBindings: 0,
      pendingBindings: 0,
      revokedBindings: 0,
      messageJa: featureCheck.messageJa,
      nextStepJa: "環境変数 P0_EMPLOYEE_IDENTITY_ENABLED=true を設定してください。",
    };
  }

  const bindings = await listIdentityBindings(orgId, { includeRevoked: true });
  const active = bindings.filter((b) => b.status === "active");
  const pending = bindings.filter((b) => b.status === "pending");
  const revoked = bindings.filter((b) => b.status === "revoked");

  let messageJa: string;
  let nextStepJa: string;

  if (bindings.length === 0) {
    messageJa = "AI社員のアイデンティティバインディングが設定されていません。";
    nextStepJa = "employeeIdentity.upsert で AI社員を責任者メンバーにバインドしてください。";
  } else if (active.length > 0) {
    messageJa = `${active.length} 件のアクティブなバインディングがあります。`;
    nextStepJa = pending.length > 0
      ? `残り ${pending.length} 件のバインディングの有効化を完了してください。`
      : "必要に応じて employeeIdentity.bindMailbox でメールボックスをバインドしてください。";
  } else {
    messageJa = `${pending.length} 件のバインディングが保留中です。`;
    nextStepJa = "承認を完了してバインディングを有効化してください。";
  }

  return {
    enabled: true,
    totalBindings: bindings.length,
    activeBindings: active.length,
    pendingBindings: pending.length,
    revokedBindings: revoked.length,
    messageJa,
    nextStepJa,
  };
}

function mapBindingRow(row: Record<string, unknown>): EmployeeIdentityBinding {
  return {
    id: String(row.id || ""),
    orgId: String(row.org_id || ""),
    employeeId: String(row.employee_id || ""),
    responsibleMemberId: String(row.responsible_member_id || ""),
    mailboxId: row.mailbox_id ? String(row.mailbox_id) : null,
    status: (row.status as EmployeeIdentityStatus) || "pending",
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    revokedBy: row.revoked_by ? String(row.revoked_by) : null,
  };
}

export function resetDemoIdentityBindings(): void {
  demoBindings.clear();
}
