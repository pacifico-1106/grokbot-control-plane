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
  demoUpdateApproval,
  getDemoApprovalsBackend,
  isDurableDemoApprovalsStore,
} from "./demo-approvals-store";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapApprovalRow } from "./mappers";
import type { ApprovalRequest } from "../types";
import { generateTelegramRef } from "../approvals/tokens";
import { assertNotSelfApproval } from "@/lib/admin-mcp/self-approval";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { initializeWorkflowForApproval } from "@/lib/approval-workflow/resolve";
import { resolveApprovalWithWorkflow, type WorkflowResolverOptions } from "@/lib/approvals/workflow-integration";

function looksLikeUuid(value: string | null | undefined): boolean {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
      )
  );
}

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
  parentApprovalId?: string | null;
  metadata?: Record<string, unknown>;
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
  const telegramRef = generateTelegramRef();
  let parent: ApprovalRequest | null = null;
  if (input.parentApprovalId) {
    parent = await getApprovalById(input.parentApprovalId, input.orgId);
    if (
      !parent ||
      parent.status !== "revision_requested" ||
      parent.employeeId !== input.employeeId ||
      parent.jobId !== (input.jobId ?? null)
    ) {
      throw new Error("invalid_parent_approval");
    }
  }
  const revisionCount = parent?.revisionCount ?? 0;

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
      revisionCount,
      parentApprovalId: parent?.id ?? null,
      telegramRef,
      metadata: input.metadata,
    };
    const approval = await demoCreateApproval(demoInput);
    await initializeWorkflowForApproval(approval, input.employeeId || null);
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
    ...(input.metadata ?? {}),
    title: input.title,
    tool: input.tool ?? null,
    jobId: input.jobId ?? null,
    statusToken,
    pollPath: "", // filled after insert with real id
    revisionCount,
    parentApprovalId: parent?.id ?? null,
    telegramRef,
  };

  const insertPayload: Record<string, unknown> = {
    org_id: input.orgId,
    employee_id: looksLikeUuid(input.employeeId) ? input.employeeId : null,
    credential_id: looksLikeUuid(input.credentialId) ? input.credentialId : null,
    purpose: input.purpose,
    summary: input.summary,
    risk: input.risk,
    status: "pending",
    title: input.title,
    tool: input.tool ?? null,
    job_id: input.jobId ?? null,
    revision_count: revisionCount,
    parent_approval_id: parent?.id ?? null,
    telegram_ref: telegramRef,
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
      employee_id: looksLikeUuid(input.employeeId) ? input.employeeId : null,
      credential_id: looksLikeUuid(input.credentialId) ? input.credentialId : null,
      purpose: input.purpose,
      summary: input.summary,
      risk: input.risk,
      status: "pending",
      metadata: {
        title: input.title,
        tool: input.tool ?? null,
        jobId: input.jobId ?? null,
        statusToken,
        revisionCount,
        parentApprovalId: parent?.id ?? null,
        telegramRef,
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
    employee_id: looksLikeUuid(input.employeeId) ? input.employeeId : null,
    credential_id: looksLikeUuid(input.credentialId) ? input.credentialId : null,
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
    revision_count: revisionCount,
    parent_approval_id: parent?.id ?? null,
    telegram_ref: telegramRef,
    status_token: statusToken,
    poll_path: pollPath,
    metadata: metaUpdate,
  });

  await initializeWorkflowForApproval(mapped, input.employeeId || null);
  return {
    approval: mapped,
    statusToken,
    pollUrl: buildPollUrl(id, statusToken),
    demo: false,
  };
}

export async function resolveApproval(
  id: string, status: "approved" | "rejected" | "revision_requested", resolvedBy: string,
  orgId?: string | null, opts: WorkflowResolverOptions = {}
): Promise<ApprovalRequest | null> {
  if (!id || !orgId) return null;
  const result = await resolveApprovalWithWorkflow(id, status, resolvedBy, orgId, opts);
  // Old callers only run fulfillment/notifications when a ticket actually resolves.
  return result.ok && result.workflowComplete ? result.approval : null;
}

/**
 * Internal finalization only. Production F8 finalization happens in the vote RPC.
 *
 * P0 Item 1: When admin_approver_enforcement is ON for the org, admin-class tickets
 * MUST have a valid memberId. The RPC resolve_approval_w1_checked performs atomic
 * authorization check and update. For non-admin tickets or when enforcement is OFF,
 * the memberId can be null but providing it is recommended for audit trail.
 *
 * @param id - Approval request ID
 * @param status - Target status
 * @param resolvedBy - Actor string for audit (e.g. 'slack:U123', 'web:user@example.com')
 * @param orgId - Organization ID
 * @param opts.memberId - Member ID of the resolver (REQUIRED for admin-class when enforcement ON)
 * @param opts.revisionNote - Required for revision_requested status
 * @param opts.decisionId - Decision ID for replay protection
 */
export async function resolveApprovalWithoutWorkflow(
  id: string,
  status: "approved" | "rejected" | "revision_requested",
  resolvedBy: string,
  orgId?: string | null,
  opts: {
    memberId?: string | null;
    revisionNote?: string;
    grokBotAgentId?: string | null;
    actorId?: string | null;
    decisionId?: string;
    externalVoter?: { provider: "slack" | "telegram" | "line"; channelKey: string; userId: string };
  } = {}
): Promise<ApprovalRequest | null> {
  if (!id || !orgId) return null;
  const revisionNote = opts.revisionNote?.trim() || null;
  if (status === "revision_requested" && !revisionNote) return null;
  if (isDemoMode()) {
    const existing = await demoGetApproval(id);
    if (!existing || existing.orgId !== orgId) return null;
    if (existing.status !== "pending") return null;
    if (isAdminClassApproval(existing)) {
      assertNotSelfApproval(existing.metadata, {
        actor: resolvedBy,
        actorId: opts.actorId,
        grokBotAgentId: opts.grokBotAgentId,
      });
    }
    return demoResolveApproval(id, status, resolvedBy, revisionNote || undefined);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const existing = await getApprovalById(id, orgId);
  if (!existing || existing.status !== "pending") return null;
  if (isAdminClassApproval(existing)) {
    assertNotSelfApproval(existing.metadata, {
      actor: resolvedBy,
      actorId: opts.actorId,
      grokBotAgentId: opts.grokBotAgentId,
    });
  }

  // Use the security definer RPC for atomic authorization check and update
  // This ensures admin-class tickets with enforcement ON have a verified resolver
  const { data: rpcResult, error: rpcError } = await admin.rpc("resolve_approval_w1_checked", {
    p_id: id,
    p_org: orgId,
    p_member_id: opts.memberId || null,
    p_decision: status,
    p_actor: resolvedBy,
    p_revision_note: revisionNote,
    p_decision_id: opts.decisionId || null,
  });

  if (rpcError) {
    console.error("resolve_approval_w1_checked_error", rpcError);
    return null;
  }

  const result = rpcResult as { ok: boolean; reason?: string; approval_id?: string };
  if (!result.ok) {
    console.warn("resolve_approval_w1_checked_rejected", { id, orgId, reason: result.reason });
    return null;
  }

  // Fetch the updated approval
  const updated = await getApprovalById(id, orgId);
  if (!updated) return null;

  // Insert audit event
  await admin.from("audit_events").insert({
    org_id: orgId,
    employee_id: updated.employeeId,
    credential_id: updated.credentialId,
    actor_email: resolvedBy,
    action:
      status === "revision_requested"
        ? "approval.revision_requested"
        : "approval.resolved",
    purpose: updated.purpose,
    summary:
      status === "approved"
        ? `承認: ${updated.title || updated.summary}`
        : status === "revision_requested"
          ? `修正依頼: ${updated.title || updated.summary}`
          : `却下: ${updated.title || updated.summary}`,
    metadata: {
      decision: status,
      resolvedBy,
      memberId: opts.memberId || null,
      tool: updated.tool ?? null,
      jobId: updated.jobId ?? null,
      revisionNote: updated.revisionNote,
      revisionCount: updated.revisionCount,
    },
  });

  updated.resolvedBy = resolvedBy;
  return updated;
}

export async function getApprovalByTelegramRef(
  telegramRef: string,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (!telegramRef) return null;
  if (isDemoMode()) {
    const rows = await demoListApprovals();
    const match = rows.find((row) => row.telegramRef === telegramRef) ?? null;
    if (match && orgId && match.orgId !== orgId) return null;
    return match;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  let query = admin
    .from("approval_requests")
    .select("*")
    .eq("telegram_ref", telegramRef);
  if (orgId) {
    query = query.eq("org_id", orgId);
  }
  const { data, error } = await query.maybeSingle();
  return error || !data
    ? null
    : mapApprovalRow(data as Record<string, unknown>);
}

export async function getApprovalByTelegramMessageId(
  messageId: number,
  orgId?: string | null
): Promise<ApprovalRequest | null> {
  if (!Number.isSafeInteger(messageId)) return null;
  if (isDemoMode()) {
    const rows = await demoListApprovals();
    const match = rows.find((row) => row.telegramMessageId === messageId) ?? null;
    if (match && orgId && match.orgId !== orgId) return null;
    return match;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  let query = admin
    .from("approval_requests")
    .select("*")
    .eq("telegram_message_id", messageId);
  if (orgId) {
    query = query.eq("org_id", orgId);
  }
  const { data, error } = await query.maybeSingle();
  return error || !data
    ? null
    : mapApprovalRow(data as Record<string, unknown>);
}

export async function updateApprovalTelegramState(
  approval: ApprovalRequest,
  patch: {
    telegramMessageId?: number;
    awaitingRevisionFrom?: number | string | null;
    awaitingRevisionChannelId?: string | null;
    awaitingRevisionProvider?: "telegram" | "line" | null;
  }
): Promise<ApprovalRequest | null> {
  const metadata = { ...approval.metadata };
  if (patch.awaitingRevisionFrom === null) {
    delete metadata.awaiting_revision_from;
  } else if (patch.awaitingRevisionFrom !== undefined) {
    metadata.awaiting_revision_from = patch.awaitingRevisionFrom;
  }
  if (patch.telegramMessageId !== undefined) {
    metadata.telegramMessageId = patch.telegramMessageId;
  }
  if (patch.awaitingRevisionChannelId === null) {
    delete metadata.awaiting_revision_channel_id;
  } else if (patch.awaitingRevisionChannelId !== undefined) {
    metadata.awaiting_revision_channel_id = patch.awaitingRevisionChannelId;
  }
  if (patch.awaitingRevisionProvider === null) {
    delete metadata.awaiting_revision_provider;
  } else if (patch.awaitingRevisionProvider !== undefined) {
    metadata.awaiting_revision_provider = patch.awaitingRevisionProvider;
  }

  if (isDemoMode()) {
    return demoUpdateApproval(approval.id, {
      metadata,
      ...(patch.telegramMessageId !== undefined
        ? { telegramMessageId: patch.telegramMessageId }
        : {}),
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const update: Record<string, unknown> = { metadata };
  if (patch.telegramMessageId !== undefined) {
    update.telegram_message_id = patch.telegramMessageId;
  }
  const { data, error } = await admin
    .from("approval_requests")
    .update(update)
    .eq("id", approval.id)
    .eq("org_id", approval.orgId)
    .select("*")
    .maybeSingle();
  return error || !data
    ? null
    : mapApprovalRow(data as Record<string, unknown>);
}

export async function updateApprovalMetadata(
  approval: ApprovalRequest,
  patch: Record<string, unknown>
): Promise<ApprovalRequest | null> {
  if (!approval?.id) return null;
  if (isDemoMode()) {
    const current = await demoGetApproval(approval.id);
    if (!current || current.orgId !== approval.orgId) return null;
    const metadata = { ...current.metadata, ...patch };
    if (current.metadata.adminSecretConsumed === true) {
      metadata.adminSecretConsumed = true;
      for (const key of ["fulfillment", "adminFulfillment"]) {
        if (metadata[key] && typeof metadata[key] === "object") {
          const value = { ...(metadata[key] as Record<string, unknown>) };
          delete value.oneTimeSecret;
          metadata[key] = value;
        }
      }
    }
    return demoUpdateApproval(approval.id, { metadata });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.rpc("merge_approval_metadata", {
    p_id: approval.id, p_org: approval.orgId, p_patch: patch,
  });
  if (error) throw new Error("approval_metadata_save_failed");
  return data ? mapApprovalRow(data as Record<string, unknown>) : null;
}

export async function listApprovalsForTelegramDigest(): Promise<ApprovalRequest[]> {
  if (isDemoMode()) return demoListApprovals();
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((row) => mapApprovalRow(row as Record<string, unknown>));
}

/**
 * Check if a decision approval has an effective deadline.
 * Returns true if:
 * - Has explicit deadlineAt in metadata, OR
 * - Is T2 (legacy fallback uses creation + 72h)
 */
function hasEffectiveDeadline(approval: ApprovalRequest): boolean {
  const m = approval.metadata as Record<string, unknown> | null;
  if (m?.type !== "decision_request") return false;
  if (approval.status !== "pending") return false;

  // Has explicit deadlineAt
  if (m?.deadlineAt) return true;

  // Legacy T2 (uses creation + 72h)
  if (m?.tier === "T2") return true;

  return false;
}

/**
 * List pending decision approvals that have deadlines for expiry cron.
 * Includes:
 * - Decisions with explicit deadlineAt in metadata
 * - Legacy T2 decisions (use creation + 72h fallback)
 * Paginates to avoid PostgREST 1000 row limit.
 */
export async function listPendingDecisionsWithDeadlines(orgId?: string | null): Promise<ApprovalRequest[]> {
  if (isDemoMode()) {
    const all = await demoListApprovals();
    return all.filter(hasEffectiveDeadline);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const PAGE_SIZE = 500;
  const results: ApprovalRequest[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = admin
      .from("approval_requests")
      .select("*")
      .eq("status", "pending")
      .contains("metadata", { type: "decision_request" })
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (orgId) {
      query = query.eq("org_id", orgId);
    }

    const { data, error } = await query;

    if (error || !data) break;

    // Filter in code: has deadlineAt OR is T2
    const filtered = data
      .map((row) => mapApprovalRow(row as Record<string, unknown>))
      .filter(hasEffectiveDeadline);

    results.push(...filtered);

    if (data.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      offset += PAGE_SIZE;
    }
  }

  return results;
}

/**
 * List pending T2 decision approvals for expiry cron.
 * @deprecated Use listPendingDecisionsWithDeadlines for all decisions with deadlines.
 * Filters at DB level: status=pending, metadata->type=decision_request, metadata->tier=T2.
 * Paginates to avoid PostgREST 1000 row limit.
 */
export async function listPendingT2Decisions(): Promise<ApprovalRequest[]> {
  if (isDemoMode()) {
    const all = await demoListApprovals();
    return all.filter((a) => {
      const m = a.metadata as Record<string, unknown> | null;
      return a.status === "pending" && m?.type === "decision_request" && m?.tier === "T2";
    });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const PAGE_SIZE = 500;
  const results: ApprovalRequest[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await admin
      .from("approval_requests")
      .select("*")
      .eq("status", "pending")
      .contains("metadata", { type: "decision_request", tier: "T2" })
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error || !data) break;

    results.push(...data.map((row) => mapApprovalRow(row as Record<string, unknown>)));

    if (data.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      offset += PAGE_SIZE;
    }
  }

  return results;
}

export { isDurableDemoApprovalsStore, getDemoApprovalsBackend };

/**
 * Approved tickets for one employee + tool, newest first (bounded).
 * Used by config.change_request to read the applied-change ledger.
 */
export async function listApprovedApprovalsForEmployeeTool(
  orgId: string,
  employeeId: string,
  tool: string,
  limit = 50
): Promise<ApprovalRequest[]> {
  if (!orgId || !employeeId || !tool) return [];
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  if (isDemoMode()) {
    return (await demoListApprovals())
      .filter(
        (row) =>
          row.orgId === orgId &&
          row.employeeId === employeeId &&
          row.tool === tool &&
          row.status === "approved"
      )
      .sort((a, b) => String(b.resolvedAt || b.createdAt).localeCompare(String(a.resolvedAt || a.createdAt)))
      .slice(0, cap);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .eq("tool", tool)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(cap);
  if (error) throw new Error("approval_ledger_unavailable");
  return (data || []).map((r) => mapApprovalRow(r as Record<string, unknown>));
}

/**
 * Pending approvals for conversation tools (COMM_REPLY_DEDUP_ENABLED), newest
 * first, bounded. employeeId / orgId null = any (expiry sweep from cron only).
 * createdBeforeIso: only rows created strictly before this time.
 */
export async function listPendingApprovalsForTools(input: {
  orgId?: string | null;
  employeeId?: string | null;
  tools: readonly string[];
  createdBeforeIso?: string | null;
  limit?: number;
}): Promise<ApprovalRequest[]> {
  const cap = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  if (!input.tools.length) return [];
  if (isDemoMode()) {
    const before = input.createdBeforeIso ? Date.parse(input.createdBeforeIso) : Number.POSITIVE_INFINITY;
    return (await demoListApprovals())
      .filter(
        (row) =>
          row.status === "pending" &&
          (!input.orgId || row.orgId === input.orgId) &&
          (!input.employeeId || row.employeeId === input.employeeId) &&
          input.tools.includes(String(row.tool || "")) &&
          Date.parse(row.createdAt) < before
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, cap);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  let query = admin
    .from("approval_requests")
    .select("*")
    .eq("status", "pending")
    .in("tool", [...input.tools]);
  if (input.orgId) query = query.eq("org_id", input.orgId);
  if (input.employeeId) query = query.eq("employee_id", input.employeeId);
  if (input.createdBeforeIso) query = query.lt("created_at", input.createdBeforeIso);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(cap);
  if (error) throw new Error("approval_list_unavailable");
  return (data || []).map((r) => mapApprovalRow(r as Record<string, unknown>));
}

/**
 * Close an approval WITHOUT sending: pending|approved → superseded|expired.
 * Conditional on the current status (a concurrent approve / fulfill wins), so
 * it never reopens or overrides a decided ticket. Returns the closed row or
 * null when the status had already moved (or the id is not this org's).
 * The status, resolved_at and `closedWithoutSend` metadata land in ONE write
 * (木村 #286 pre-flag item 5: two writes left "superseded" with no reason when
 * the second failed): close_approval_without_send (migration 20261009150000,
 * jsonb merge in the same UPDATE). Until that migration is applied, one
 * PostgREST UPDATE carries status + metadata (read-merge-write of the row's
 * metadata, still conditional on the status). Throws when the write fails —
 * nothing is changed then.
 */
export async function closeApprovalWithoutSend(input: {
  approval: Pick<ApprovalRequest, "id" | "orgId">;
  from: ReadonlyArray<"pending" | "approved">;
  to: "superseded" | "expired";
  meta: Record<string, unknown>;
}): Promise<ApprovalRequest | null> {
  const { approval, from, to } = input;
  if (!approval?.id || !approval.orgId || !from.length) return null;
  const at = new Date().toISOString();
  const closedWithoutSend = { status: to, at, ...input.meta };
  if (isDemoMode()) {
    const current = await demoGetApproval(approval.id);
    if (!current || current.orgId !== approval.orgId) return null;
    if (!(from as readonly string[]).includes(current.status)) return null;
    return demoUpdateApproval(approval.id, {
      status: to,
      resolvedAt: at,
      metadata: { ...current.metadata, closedWithoutSend },
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const rpc = await admin.rpc("close_approval_without_send", {
    p_id: approval.id,
    p_org: approval.orgId,
    p_from: [...from],
    p_to: to,
    p_patch: input.meta,
  });
  if (!rpc.error) return rpc.data ? mapApprovalRow(rpc.data as Record<string, unknown>) : null;
  if (!isMissingFunctionError(rpc.error)) throw new Error("approval_close_failed");
  // Before migration 20261009150000: still ONE write (status + metadata together).
  const read = await admin
    .from("approval_requests")
    .select("*")
    .eq("id", approval.id)
    .eq("org_id", approval.orgId)
    .maybeSingle();
  if (read.error) throw new Error("approval_close_failed");
  if (!read.data) return null;
  const currentRow = read.data as Record<string, unknown>;
  if (!(from as readonly string[]).includes(String(currentRow.status ?? ""))) return null;
  const currentMeta =
    currentRow.metadata && typeof currentRow.metadata === "object" && !Array.isArray(currentRow.metadata)
      ? (currentRow.metadata as Record<string, unknown>)
      : {};
  const { data, error } = await admin
    .from("approval_requests")
    .update({ status: to, resolved_at: at, metadata: { ...currentMeta, closedWithoutSend } })
    .eq("id", approval.id)
    .eq("org_id", approval.orgId)
    .in("status", [...from])
    .select("*")
    .maybeSingle();
  if (error) throw new Error("approval_close_failed");
  return data ? mapApprovalRow(data as Record<string, unknown>) : null;
}

function isMissingFunctionError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(String(error.message ?? ""));
}
