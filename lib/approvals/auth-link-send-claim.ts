/**
 * Auth-link mail.send CAS: take "sending" once, consume after provider
 * success, release on retryable failure. oobCode / apiKey are never stored.
 *
 * sending carries sentAt + TTL. Expired sending becomes uncertain (never
 * reclaimed, never resent) so a crashed sender cannot double-send.
 */
import { getRuntimeApprovals } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { ApprovalRequest } from "@/lib/types";

export const AUTH_LINK_SEND_TTL_SECONDS = 600;

export const AUTH_LINK_SEND_UNCERTAIN_MESSAGE =
  "この認証リンクは送信結果が不明なため再送しません。運用確認が必要です。";

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
  sentAt?: string;
  sendingAt?: string;
  ttlSeconds?: number;
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

function isStaleSending(meta: FulfillmentMeta, nowMs = Date.now()): boolean {
  if (meta.status !== "sending" && meta.sending !== true) return false;
  const started = meta.sentAt || meta.sendingAt;
  if (!started) return true;
  const startMs = Date.parse(started);
  if (!Number.isFinite(startMs)) return true;
  const ttl =
    typeof meta.ttlSeconds === "number" && meta.ttlSeconds > 0
      ? meta.ttlSeconds
      : AUTH_LINK_SEND_TTL_SECONDS;
  return nowMs - startMs > ttl * 1000;
}

function persistUncertain(row: ApprovalRequest, approval: ApprovalRequest, jobId: string, at: string): void {
  writeRuntime(row, {
    status: "uncertain",
    consumed: false,
    uncertainAt: at,
    uncertainByJobId: jobId,
  });
  approval.metadata = row.metadata;
}

function classify(meta: FulfillmentMeta): AuthLinkSendClaim {
  if (meta.consumed === true || meta.status === "consumed") {
    return { ok: false, code: "auth_link_already_sent" };
  }
  if (meta.status === "uncertain" || isStaleSending(meta)) {
    return { ok: false, code: "auth_link_send_uncertain" };
  }
  if (meta.status === "sending" || meta.sending === true) {
    return { ok: false, code: "auth_link_send_in_progress" };
  }
  return { ok: true };
}

function expireStaleDemo(approval: ApprovalRequest, at: string): AuthLinkSendClaim | null {
  const row = findRuntime(approval.id, approval.orgId) ?? approval;
  const meta = readMeta(row);
  if (!isStaleSending(meta)) return null;
  persistUncertain(row, approval, meta.sendingByJobId || "ttl-expired", at);
  return { ok: false, code: "auth_link_send_uncertain" };
}

function demoClaim(approval: ApprovalRequest, jobId: string, at: string): AuthLinkSendClaim {
  const expired = expireStaleDemo(approval, at);
  if (expired) return expired;
  const row = findRuntime(approval.id, approval.orgId);
  if (!row) return { ok: false, code: "auth_link_send_unavailable" };
  const current = classify(readMeta(row));
  if (!current.ok) return current;
  writeRuntime(row, {
    status: "sending",
    sendingAt: at,
    sentAt: at,
    ttlSeconds: AUTH_LINK_SEND_TTL_SECONDS,
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
  const forced = takeAuthLinkConsumeResultForTests();
  if (forced !== null) return forced;
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
  if (isDemoMode()) {
    const expired = expireStaleDemo(approval, new Date().toISOString());
    if (expired) return expired;
  }
  return classify(readMeta(approval));
}

/** Test-only: next consumeAuthLinkSend returns this boolean. */
let consumeResultForTests: boolean | null = null;
/** Test-only: called after provider send succeeds (wired in invoke). */
let afterProviderSendForTests: (() => void) | null = null;

export function setAuthLinkConsumeResultForTests(result: boolean | null): void {
  consumeResultForTests = result;
}

export function setAuthLinkAfterProviderSendForTests(hook: (() => void) | null): void {
  afterProviderSendForTests = hook;
}

export function takeAuthLinkConsumeResultForTests(): boolean | null {
  const value = consumeResultForTests;
  consumeResultForTests = null;
  return value;
}

export function runAuthLinkAfterProviderSendForTests(): void {
  afterProviderSendForTests?.();
}
