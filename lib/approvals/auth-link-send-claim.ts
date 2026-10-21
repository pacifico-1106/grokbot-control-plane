/**
 * Auth-link mail.send CAS: take "sending" once, consume after provider
 * success, release on retryable failure. oobCode / apiKey are never stored.
 */
import { getRuntimeApprovals } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ApprovalRequest } from "@/lib/types";

export type AuthLinkSendClaim =
  | { ok: true }
  | {
      ok: false;
      code:
        | "auth_link_already_sent"
        | "auth_link_send_in_progress"
        | "auth_link_send_uncertain"
        | "auth_link_send_unavailable";
    };

type FulfillmentMeta = {
  status?: string;
  consumed?: boolean;
  sending?: boolean;
  sendingByJobId?: string;
};

function readMeta(approval: ApprovalRequest | null | undefined): FulfillmentMeta {
  const raw = approval?.metadata?.authLinkFulfillment;
  if (!raw || typeof raw !== "object") return {};
  return raw as FulfillmentMeta;
}

function findRuntime(approvalId: string, orgId: string): ApprovalRequest | null {
  return getRuntimeApprovals().find((row) => row.id === approvalId && row.orgId === orgId) ?? null;
}

function writeRuntime(row: ApprovalRequest, next: Record<string, unknown>): void {
  row.metadata = { ...row.metadata, authLinkFulfillment: next };
}

function classify(meta: FulfillmentMeta): AuthLinkSendClaim {
  if (meta.consumed === true || meta.status === "consumed") {
    return { ok: false, code: "auth_link_already_sent" };
  }
  if (meta.status === "uncertain") {
    return { ok: false, code: "auth_link_send_uncertain" };
  }
  if (meta.status === "sending" || meta.sending === true) {
    return { ok: false, code: "auth_link_send_in_progress" };
  }
  return { ok: true };
}

function demoClaim(approval: ApprovalRequest, jobId: string, at: string): AuthLinkSendClaim {
  const row = findRuntime(approval.id, approval.orgId);
  if (!row) return { ok: false, code: "auth_link_send_unavailable" };
  const current = classify(readMeta(row));
  if (!current.ok) return current;
  writeRuntime(row, {
    status: "sending",
    sendingAt: at,
    sendingByJobId: jobId,
    consumed: false,
  });
  approval.metadata = row.metadata;
  return { ok: true };
}

export async function claimAuthLinkSend(
  approval: ApprovalRequest,
  jobId: string
): Promise<AuthLinkSendClaim> {
  const at = new Date().toISOString();
  if (isDemoMode()) return demoClaim(approval, jobId, at);
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "auth_link_send_unavailable" };
  const { data, error } = await admin.rpc("claim_auth_link_send", {
    p_id: approval.id,
    p_org: approval.orgId,
    p_job_id: jobId,
    p_at: at,
  });
  if (error || typeof data !== "string") return { ok: false, code: "auth_link_send_unavailable" };
  if (data === "claimed") return { ok: true };
  if (data === "consumed") return { ok: false, code: "auth_link_already_sent" };
  if (data === "sending") return { ok: false, code: "auth_link_send_in_progress" };
  if (data === "uncertain") return { ok: false, code: "auth_link_send_uncertain" };
  return { ok: false, code: "auth_link_send_unavailable" };
}

export async function releaseAuthLinkSend(approval: ApprovalRequest, jobId: string): Promise<boolean> {
  if (isDemoMode()) {
    const row = findRuntime(approval.id, approval.orgId);
    if (!row) return false;
    const meta = readMeta(row);
    if (meta.status !== "sending" || meta.sendingByJobId !== jobId) return false;
    writeRuntime(row, { status: "failed", consumed: false });
    approval.metadata = row.metadata;
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("release_auth_link_send", {
    p_id: approval.id,
    p_org: approval.orgId,
    p_job_id: jobId,
  });
  return !error && data === true;
}

export async function consumeAuthLinkSend(approval: ApprovalRequest, jobId: string): Promise<boolean> {
  const at = new Date().toISOString();
  if (isDemoMode()) {
    const row = findRuntime(approval.id, approval.orgId);
    if (!row) return false;
    const meta = readMeta(row);
    if (meta.status !== "sending" || meta.sendingByJobId !== jobId) return false;
    writeRuntime(row, {
      status: "consumed",
      consumed: true,
      consumedAt: at,
      consumedByJobId: jobId,
    });
    approval.metadata = row.metadata;
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("consume_auth_link_send", {
    p_id: approval.id,
    p_org: approval.orgId,
    p_job_id: jobId,
    p_at: at,
  });
  return !error && data === true;
}

export async function markAuthLinkSendUncertain(
  approval: ApprovalRequest,
  jobId: string
): Promise<boolean> {
  const at = new Date().toISOString();
  if (isDemoMode()) {
    const row = findRuntime(approval.id, approval.orgId);
    if (!row) return false;
    const meta = readMeta(row);
    if (meta.status !== "sending" || meta.sendingByJobId !== jobId) return false;
    writeRuntime(row, {
      status: "uncertain",
      consumed: false,
      uncertainAt: at,
      uncertainByJobId: jobId,
    });
    approval.metadata = row.metadata;
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { data, error } = await admin.rpc("mark_auth_link_send_uncertain", {
    p_id: approval.id,
    p_org: approval.orgId,
    p_job_id: jobId,
    p_at: at,
  });
  return !error && data === true;
}

export function authLinkFulfillmentBlocksReplay(approval: ApprovalRequest): AuthLinkSendClaim {
  return classify(readMeta(approval));
}
