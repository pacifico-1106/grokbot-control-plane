import {
  type CreateRuntimeApprovalInput,
} from "../demo-data";
import {
  buildPollPath,
  buildPollUrl,
  generateStatusToken,
  statusTokensEqual,
} from "../approvals/tokens";
import {
  demoCreateApproval,
  demoGetApproval,
  demoListApprovals,
  demoResolveApproval,
  getDemoApprovalsBackend,
  isDurableDemoApprovalsStore,
} from "./demo-approvals-store";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapApprovalRow } from "./mappers";
import type { ApprovalRequest } from "../types";

export type CreateApprovalInput = {
  orgId: string;
  employeeId: string;
  credentialId: string;
  title: string;
  purpose: string;
  summary: string;
  risk: ApprovalRequest["risk"];
  tool?: string | null;
  jobId?: string | null;
};

export type CreateApprovalResult = {
  approval: ApprovalRequest;
  pollUrl: string;
  /** Plain status token (Bot must persist; may not be re-readable from DB hash stores). */
  statusToken: string;
  demo: boolean;
  /** DEMO only: which backing store held the ticket. */
  demoStore?: "upstash" | "github" | "http" | "memory";
};

export async function listApprovals(
  orgId?: string | null
): Promise<ApprovalRequest[]> {
  if (isDemoMode()) return demoListApprovals();
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return [];
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r) => mapApprovalRow(r as Record<string, unknown>));
}

export async function getApprovalById(
  id: string,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (!id || !orgId) return null;
  if (isDemoMode()) {
    const row = await demoGetApproval(id);
    if (!row || row.orgId !== orgId) return null;
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return null;
  return mapApprovalRow(data as Record<string, unknown>);
}

/**
 * Public-ish status lookup: id + statusToken required.
 * Demo: plaintext token on row. Prod: status_token column or metadata.
 */
export async function getApprovalStatusByToken(
  id: string,
  token: string
): Promise<ApprovalRequest | null> {
  if (!id || !token) return null;

  let row: ApprovalRequest | null = null;
  if (isDemoMode()) {
    row = await demoGetApproval(id);
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) return null;
    const { data, error } = await admin
      .from("approval_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    row = mapApprovalRow(data as Record<string, unknown>);
  }

  if (!row?.statusToken) return null;
  // statusTokensEqual hashes both sides (timing-safe).
  if (!statusTokensEqual(token, row.statusToken)) return null;
  return row;
}

export async function createApproval(
  input: CreateApprovalInput
): Promise<CreateApprovalResult> {
  const statusToken = generateStatusToken();

  if (isDemoMode()) {
    const demoInput: CreateRuntimeApprovalInput = {
      employeeId: input.employeeId,
      credentialId: input.credentialId || "cred_unknown",
      title: input.title,
      purpose: input.purpose,
      summary: input.summary,
      risk: input.risk,
      tool: input.tool,
      jobId: input.jobId,
      statusToken,
    };
    const approval = await demoCreateApproval(demoInput);
    return {
      approval,
      statusToken: approval.statusToken || statusToken,
      pollUrl: buildPollUrl(approval.id, approval.statusToken || statusToken),
      demo: true,
      demoStore: getDemoApprovalsBackend(),
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const metadata = {
    title: input.title,
    tool: input.tool ?? null,
    jobId: input.jobId ?? null,
    statusToken,
    pollPath: "", // filled after insert with real id
  };

  const insertPayload: Record<string, unknown> = {
    org_id: input.orgId,
    employee_id: input.employeeId,
    credential_id: input.credentialId,
    purpose: input.purpose,
    summary: input.summary,
    risk: input.risk,
    status: "pending",
    title: input.title,
    tool: input.tool ?? null,
    job_id: input.jobId ?? null,
    status_token: statusToken,
    metadata,
  };

  let { data, error } = await admin
    .from("approval_requests")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  // Fallback: older schema without new columns — metadata only.
  if (error) {
    const legacy = {
      org_id: input.orgId,
      employee_id: input.employeeId,
      credential_id: input.credentialId,
      purpose: input.purpose,
      summary: input.summary,
      risk: input.risk,
      status: "pending",
      metadata: {
        title: input.title,
        tool: input.tool ?? null,
        jobId: input.jobId ?? null,
        statusToken,
      },
    };
    const retry = await admin
      .from("approval_requests")
      .insert(legacy)
      .select("*")
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    throw new Error(error?.message || "approval_create_failed");
  }

  const id = String((data as { id: string }).id);
  const pollPath = buildPollPath(id, statusToken);
  const metaUpdate = {
    ...(typeof (data as { metadata?: unknown }).metadata === "object" &&
    (data as { metadata?: object }).metadata
      ? ((data as { metadata: Record<string, unknown> }).metadata as Record<
          string,
          unknown
        >)
      : {}),
    title: input.title,
    tool: input.tool ?? null,
    jobId: input.jobId ?? null,
    statusToken,
    pollPath,
  };

  await admin
    .from("approval_requests")
    .update({
      poll_path: pollPath,
      metadata: metaUpdate,
    })
    .eq("id", id);

  await admin.from("audit_events").insert({
    org_id: input.orgId,
    employee_id: input.employeeId,
    credential_id: input.credentialId,
    action: "approval.requested",
    purpose: input.purpose,
    summary: `承認待ち: ${input.title}`,
    metadata: {
      approvalId: id,
      tool: input.tool ?? null,
      jobId: input.jobId ?? null,
      risk: input.risk,
      pollPath,
    },
  });

  const mapped = mapApprovalRow({
    ...(data as Record<string, unknown>),
    title: input.title,
    tool: input.tool ?? null,
    job_id: input.jobId ?? null,
    status_token: statusToken,
    poll_path: pollPath,
    metadata: metaUpdate,
  });

  return {
    approval: mapped,
    statusToken,
    pollUrl: buildPollUrl(id, statusToken),
    demo: false,
  };
}

export async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  resolvedBy: string,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (!id || !orgId) return null;
  if (isDemoMode()) {
    const existing = await demoGetApproval(id);
    if (!existing || existing.orgId !== orgId) return null;
    return demoResolveApproval(id, status, resolvedBy);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const now = new Date().toISOString();
  const q = admin
    .from("approval_requests")
    .update({
      status,
      resolved_at: now,
      resolved_by: null,
    })
    .eq("id", id)
    .eq("org_id", orgId);
  const { data, error } = await q.select("*").maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  const mapped = mapApprovalRow(row);
  await admin.from("audit_events").insert({
    org_id: row.org_id,
    employee_id: row.employee_id,
    credential_id: row.credential_id,
    actor_email: resolvedBy,
    action: "approval.resolved",
    purpose: row.purpose,
    summary:
      status === "approved"
        ? `承認: ${mapped.title || mapped.summary}`
        : `却下: ${mapped.title || mapped.summary}`,
    metadata: {
      decision: status,
      resolvedBy,
      tool: mapped.tool ?? null,
      jobId: mapped.jobId ?? null,
    },
  });

  mapped.resolvedBy = resolvedBy;
  return mapped;
}

export { isDurableDemoApprovalsStore, getDemoApprovalsBackend };
