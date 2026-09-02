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
    revision_count: revisionCount,
    parent_approval_id: parent?.id ?? null,
    telegram_ref: telegramRef,
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
  status: "approved" | "rejected" | "revision_requested",
  resolvedBy: string,
  orgId?: string | null,
  opts: { revisionNote?: string; grokBotAgentId?: string | null; actorId?: string | null } = {}
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

  const now = new Date().toISOString();
  const existing = await getApprovalById(id, orgId);
  if (!existing || existing.status !== "pending") return null;
  if (isAdminClassApproval(existing)) {
    assertNotSelfApproval(existing.metadata, {
      actor: resolvedBy,
      actorId: opts.actorId,
      grokBotAgentId: opts.grokBotAgentId,
    });
  }
  const update: Record<string, unknown> = {
    status,
    resolved_at: now,
    resolved_by: null,
  };
  if (status === "revision_requested") {
    update.revision_note = revisionNote;
    update.revision_count = existing.revisionCount + 1;
  }
  const q = admin
    .from("approval_requests")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "pending");
  const { data, error } = await q.select("*").maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  const mapped = mapApprovalRow(row);
  await admin.from("audit_events").insert({
    org_id: row.org_id,
    employee_id: row.employee_id,
    credential_id: row.credential_id,
    actor_email: resolvedBy,
    action:
      status === "revision_requested"
        ? "approval.revision_requested"
        : "approval.resolved",
    purpose: row.purpose,
    summary:
      status === "approved"
        ? `承認: ${mapped.title || mapped.summary}`
        : status === "revision_requested"
          ? `修正依頼: ${mapped.title || mapped.summary}`
          : `却下: ${mapped.title || mapped.summary}`,
    metadata: {
      decision: status,
      resolvedBy,
      tool: mapped.tool ?? null,
      jobId: mapped.jobId ?? null,
      revisionNote: mapped.revisionNote,
      revisionCount: mapped.revisionCount,
    },
  });

  mapped.resolvedBy = resolvedBy;
  return mapped;
}

export async function getApprovalByTelegramRef(
  telegramRef: string
): Promise<ApprovalRequest | null> {
  if (!telegramRef) return null;
  if (isDemoMode()) {
    const rows = await demoListApprovals();
    return rows.find((row) => row.telegramRef === telegramRef) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("telegram_ref", telegramRef)
    .maybeSingle();
  return error || !data
    ? null
    : mapApprovalRow(data as Record<string, unknown>);
}

export async function getApprovalByTelegramMessageId(
  messageId: number
): Promise<ApprovalRequest | null> {
  if (!Number.isSafeInteger(messageId)) return null;
  if (isDemoMode()) {
    const rows = await demoListApprovals();
    return rows.find((row) => row.telegramMessageId === messageId) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .select("*")
    .eq("telegram_message_id", messageId)
    .maybeSingle();
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
  const metadata = { ...approval.metadata, ...patch };
  if (isDemoMode()) {
    return demoUpdateApproval(approval.id, { metadata });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("approval_requests")
    .update({ metadata })
    .eq("id", approval.id)
    .eq("org_id", approval.orgId)
    .select("*")
    .maybeSingle();
  return error || !data
    ? null
    : mapApprovalRow(data as Record<string, unknown>);
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

export { isDurableDemoApprovalsStore, getDemoApprovalsBackend };
