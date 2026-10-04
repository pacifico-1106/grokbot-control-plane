import {
  getRuntimeMemberById,
  getRuntimeMembers,
  setRuntimeMember,
  upsertRuntimeMember,
} from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapMemberRow } from "./mappers";
import type { OrgMember } from "../types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function normalizeMemberEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Production write id: keep a real UUID, otherwise mint one (never mem_*). */
export function resolveProductionMemberId(id?: string | null): string {
  return isUuid(id) ? id : crypto.randomUUID();
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "23505" ||
    msg.includes("duplicate key") ||
    msg.includes("unique constraint")
  );
}

export async function listMembers(orgId?: string | null): Promise<OrgMember[]> {
  if (isDemoMode()) return getRuntimeMembers();
  if (!orgId) return [];
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { data, error } = await admin
    .from("org_members")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(error.message || "member_list_failed");
  }
  return (data ?? []).map((r) => mapMemberRow(r as Record<string, unknown>));
}

export async function getMemberById(
  id: string,
  orgId?: string | null
): Promise<OrgMember | null> {
  if (isDemoMode()) return getRuntimeMemberById(id);
  const members = await listMembers(orgId);
  return members.find((m) => m.id === id) ?? null;
}

type MemberWriteFields = {
  org_id: string;
  email: string;
  display_name: string;
  role: OrgMember["role"];
  job_role: string;
  job_label: string | null;
  capabilities: NonNullable<OrgMember["capabilities"]>;
};

/**
 * What the guard decision was based on. The write only lands if the row still
 * matches (TOCTOU): `"new"` = insert only (never fall back to updating an
 * existing row), otherwise a conditional update on role + capability set.
 */
export type MemberWriteExpectation =
  | "new"
  | { role: OrgMember["role"]; capabilities: readonly string[] };

export class MemberConcurrentModificationError extends Error {
  constructor() {
    super("member_concurrent_modification");
  }
}

/** DB trigger org_members_keep_last_owner (migration 20261004200000) refused the write. */
export class MemberLastOwnerError extends Error {
  constructor() {
    super("last_owner_required");
  }
}

function sameCapabilitySet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b);
  return x.size === y.size && [...x].every((c) => y.has(c));
}

/**
 * Low-level org_members writer for role / capabilities.
 * ONLY call from lib/team/apply-member-change.ts after evaluateMemberChange
 * (enforced by tests/security/member-capability-write-paths.test.ts).
 * Audit is written by the caller (before/after + actor).
 */
export async function writeMemberRow(
  member: OrgMember,
  orgId: string,
  expected: MemberWriteExpectation
): Promise<OrgMember> {
  if (isDemoMode()) {
    const current = getRuntimeMemberById(member.id);
    if (expected === "new") {
      if (current) throw new MemberConcurrentModificationError();
    } else if (
      !current ||
      current.orgId !== orgId ||
      current.role !== expected.role ||
      !sameCapabilitySet(current.capabilities, expected.capabilities)
    ) {
      throw new MemberConcurrentModificationError();
    }
    const saved = { ...member, email: normalizeMemberEmail(member.email) };
    if (current) setRuntimeMember(saved);
    else upsertRuntimeMember(saved, { audit: false });
    return saved;
  }
  const admin = createSupabaseAdminClient();
  if (!orgId || orgId === "org_demo") {
    throw new Error("org_id_required");
  }
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const email = normalizeMemberEmail(member.email);
  const writeFields: MemberWriteFields = {
    org_id: orgId,
    email,
    display_name: member.displayName,
    role: member.role,
    job_role: member.jobRole ?? "custom",
    job_label: member.jobLabel ?? null,
    capabilities: member.capabilities ?? [],
  };

  if (expected !== "new") {
    if (!isUuid(member.id)) throw new Error("member_upsert_failed");
    const expectedCaps = [...new Set(expected.capabilities)];
    const { data, error } = await admin
      .from("org_members")
      .update(writeFields)
      .eq("id", member.id)
      .eq("org_id", orgId)
      .eq("role", expected.role)
      .contains("capabilities", expectedCaps)
      .containedBy("capabilities", expectedCaps)
      .select("*")
      .maybeSingle();
    if (error) {
      if (/last_owner_required/.test(error.message || "")) throw new MemberLastOwnerError();
      throw new Error(error.message || "member_upsert_failed");
    }
    if (!data) throw new MemberConcurrentModificationError();
    return mapMemberRow(data as Record<string, unknown>);
  }

  const { data: inserted, error: insertError } = await admin
    .from("org_members")
    .insert({
      id: resolveProductionMemberId(member.id),
      ...writeFields,
      status: member.status || "invited",
      invited_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (!insertError && inserted) {
    return mapMemberRow(inserted as Record<string, unknown>);
  }
  // A row with this (org_id, email) appeared after the guard decided: never
  // turn the invite into an unchecked update of that row.
  if (isUniqueViolation(insertError)) throw new MemberConcurrentModificationError();
  throw new Error(insertError?.message || "member_upsert_failed");
}

/**
 * Get org owner user IDs for default admin approver configuration.
 * Returns member IDs of all members with role='owner'.
 * Used when no explicit admin route is configured — org owners are default admin approvers.
 */
export async function getOrgOwnerIds(orgId: string): Promise<string[]> {
  const members = await listMembers(orgId);
  return members.filter((m) => m.role === "owner").map((m) => m.id);
}

/**
 * Get org owner members for admin approval routing.
 * Returns full member objects for role='owner' members.
 */
export async function getOrgOwners(orgId: string): Promise<OrgMember[]> {
  const members = await listMembers(orgId);
  return members.filter((m) => m.role === "owner");
}
