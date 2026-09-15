/**
 * Platform-ops proxy approval: Super Admin resolves a tenant's pending approval
 * on their behalf during setup/support. Requires mandate (setup|support) for audit.
 * 
 * Audit records: targetOrgId, approvalId, mandate, note, actorEmail, actorUserId,
 * decision, timestamp — visible on tenant change log as platform proxy action.
 */

import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { fulfillApprovedInvoke } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { appendAuditEvent } from "@/lib/data/audit";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import { mapApprovalRow } from "@/lib/data/mappers";
import { getEmployee } from "@/lib/data/employees";
import {
  demoGetApproval,
  demoResolveApproval,
} from "@/lib/data/demo-approvals-store";
import type { ApprovalRequest, AuditAction } from "@/lib/types";

export type ProxyApprovalMandate = "setup" | "support";

export const PROXY_APPROVAL_MANDATES: ProxyApprovalMandate[] = ["setup", "support"];

export const PROXY_MANDATE_LABELS_JA: Record<ProxyApprovalMandate, string> = {
  setup: "セットアップ代行",
  support: "サポート対応",
};

export type ProxyApprovalActor = {
  email: string;
  userId: string;
};

export type ProxyApproveInput = {
  targetOrgId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  mandate: ProxyApprovalMandate;
  note?: string;
  actor: ProxyApprovalActor;
};

export type ProxyApproveResult = {
  ok: boolean;
  approval?: ApprovalRequest;
  sideEffects?: unknown;
  error?: string;
  code?: string;
};

function isValidMandate(value: unknown): value is ProxyApprovalMandate {
  return PROXY_APPROVAL_MANDATES.includes(value as ProxyApprovalMandate);
}

async function getApprovalByOrgId(
  approvalId: string,
  targetOrgId: string
): Promise<ApprovalRequest | null> {
  if (!approvalId || !targetOrgId) return null;
  
  if (isDemoMode()) {
    const row = await demoGetApproval(approvalId);
    if (!row || row.orgId !== targetOrgId) return null;
    return row;
  }
  
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("id", approvalId)
    .eq("org_id", targetOrgId)
    .maybeSingle();
  
  if (error || !data) return null;
  return mapApprovalRow(data as Record<string, unknown>);
}

async function resolveApprovalByOrgId(
  approvalId: string,
  targetOrgId: string,
  status: "approved" | "rejected",
  actor: ProxyApprovalActor
): Promise<ApprovalRequest | null> {
  if (isDemoMode()) {
    const existing = await demoGetApproval(approvalId);
    if (!existing || existing.orgId !== targetOrgId) return null;
    if (existing.status !== "pending") return null;
    return demoResolveApproval(approvalId, status, actor.email);
  }
  
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  
  const now = new Date().toISOString();
  
  const { data, error } = await admin
    .from("approval_requests")
    .update({
      status,
      resolved_at: now,
      resolved_by: actor.email,
    })
    .eq("id", approvalId)
    .eq("org_id", targetOrgId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  
  if (error || !data) return null;
  
  const mapped = mapApprovalRow(data as Record<string, unknown>);
  mapped.resolvedBy = actor.email;
  return mapped;
}

export async function proxyResolveApproval(
  input: ProxyApproveInput
): Promise<ProxyApproveResult> {
  const { targetOrgId, approvalId, decision, mandate, note, actor } = input;
  
  if (!isValidMandate(mandate)) {
    return {
      ok: false,
      code: "invalid_mandate",
      error: `名目(mandate)は ${PROXY_APPROVAL_MANDATES.join(" | ")} のいずれかを指定してください`,
    };
  }
  
  if (!["approved", "rejected"].includes(decision)) {
    return {
      ok: false,
      code: "invalid_decision",
      error: "decision は approved | rejected のいずれかを指定してください",
    };
  }
  
  const existing = await getApprovalByOrgId(approvalId, targetOrgId);
  if (!existing) {
    return {
      ok: false,
      code: "approval_not_found",
      error: "指定された承認チケットが見つかりません",
    };
  }
  
  if (existing.status !== "pending") {
    return {
      ok: false,
      code: "approval_not_pending",
      error: `この承認チケットは既に処理済みです (status: ${existing.status})`,
    };
  }
  
  const updated = await resolveApprovalByOrgId(
    approvalId,
    targetOrgId,
    decision,
    actor
  );
  
  if (!updated) {
    return {
      ok: false,
      code: "resolve_failed",
      error: "承認処理に失敗しました（同時更新の可能性）",
    };
  }
  
  const decisionLabelJa = decision === "approved" ? "承認" : "却下";
  const mandateLabelJa = PROXY_MANDATE_LABELS_JA[mandate];
  const notePart = note ? ` / メモ: ${note}` : "";
  
  const auditAction: AuditAction = "admin.proxy_approve";
  await appendAuditEvent({
    orgId: targetOrgId,
    employeeId: updated.employeeId,
    credentialId: updated.credentialId,
    actorEmail: actor.email,
    action: auditAction,
    purpose: updated.purpose,
    summary: `【プラットフォーム代行${decisionLabelJa}】${mandateLabelJa}: ${updated.title || updated.summary.slice(0, 60)}${notePart}`,
    metadata: {
      proxyApproval: true,
      mandate,
      note: note || null,
      decision,
      actorEmail: actor.email,
      actorUserId: actor.userId,
      approvalId: updated.id,
      tool: updated.tool,
      jobId: updated.jobId,
    },
  });
  
  if (decision === "approved") {
    await fulfillApprovedAdmin(updated);
    await fulfillApprovedInvoke(updated);
  }
  
  const employee = await getEmployee(updated.employeeId, targetOrgId);
  const sideEffects = await runApprovalResolveSideEffects({
    approval: updated,
    decision,
    actorEmail: actor.email,
    employee,
  });
  
  return {
    ok: true,
    approval: updated,
    sideEffects,
  };
}

export async function listPendingApprovalsForOrg(
  targetOrgId: string
): Promise<ApprovalRequest[]> {
  if (!targetOrgId) return [];
  
  if (isDemoMode()) {
    const { demoListApprovals } = await import("@/lib/data/demo-approvals-store");
    const all = await demoListApprovals();
    return all.filter((a) => a.orgId === targetOrgId && a.status === "pending");
  }
  
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("org_id", targetOrgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(100);
  
  if (error || !data) return [];
  return data.map((r) => mapApprovalRow(r as Record<string, unknown>));
}
