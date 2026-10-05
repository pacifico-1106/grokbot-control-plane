/**
 * PR-B stores: proposal dedupe (channel_classify_proposals) and stuck-notice
 * rate-limit windows (channel_stuck_notice_windows). Migration 20261005200000;
 * service_role RPCs only (anon / authenticated have no access).
 *
 * Rows hold org id, a key made of surface / kind + external id, a facts hash,
 * the approval id and timestamps — never message content or tokens.
 * Store errors → { state: "unavailable" }: callers then do NOT open a ticket
 * (dedupe cannot be proven) and notices fall back to a per-instance window.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getApprovalById } from "@/lib/data/approvals";

export const PROPOSAL_KEY_RE = /^(channel|party):[a-z_]{2,20}:[A-Za-z0-9_.:@+-]{1,128}$/;
export const NOTICE_KEY_RE = /^[A-Za-z0-9_.:@+|-]{1,200}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type ProposalClaim =
  | { state: "claimed" }
  | { state: "in_flight" }
  | { state: "pending"; approvalId: string }
  | { state: "decided"; approvalId: string; status: string }
  | { state: "denied" }
  | { state: "unavailable" };

export type NoticeSlot = { state: "ok"; allowed: boolean } | { state: "denied" } | { state: "unavailable" };

type DemoProposal = { factsHash: string; approvalId: string | null; claimedAtMs: number };
const demoProposals = new Map<string, DemoProposal>();
const demoWindows = new Map<string, { windowStartMs: number; suppressed: number }>();
let demoChain: Promise<unknown> = Promise.resolve();

export function resetDemoChannelClassifyStore(): void {
  demoProposals.clear();
  demoWindows.clear();
}

function serialize<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = demoChain.then(fn);
  demoChain = run.catch(() => undefined);
  return run;
}

function dk(orgId: string, key: string): string {
  return `${orgId}\u0000${key}`;
}

export async function claimChannelClassifyProposal(input: {
  orgId: string;
  key: string;
  factsHash: string;
  staleSeconds?: number;
}): Promise<ProposalClaim> {
  const stale = Math.max(1, Math.min(86_400, Math.floor(input.staleSeconds ?? 600)));
  if (!input.orgId || !PROPOSAL_KEY_RE.test(input.key) || !HEX64.test(input.factsHash)) return { state: "denied" };
  if (isDemoMode()) {
    return serialize(async (): Promise<ProposalClaim> => {
      const k = dk(input.orgId, input.key);
      const row = demoProposals.get(k);
      const now = Date.now();
      if (!row) {
        demoProposals.set(k, { factsHash: input.factsHash, approvalId: null, claimedAtMs: now });
        return { state: "claimed" };
      }
      if (row.approvalId) {
        const approval = await getApprovalById(row.approvalId, input.orgId);
        if (approval) {
          if (approval.status === "pending" || approval.status === "revision_requested") {
            return { state: "pending", approvalId: row.approvalId };
          }
          if (row.factsHash === input.factsHash) {
            return { state: "decided", approvalId: row.approvalId, status: approval.status };
          }
        }
      } else if (now - row.claimedAtMs < stale * 1000 && row.factsHash === input.factsHash) {
        return { state: "in_flight" };
      }
      demoProposals.set(k, { factsHash: input.factsHash, approvalId: null, claimedAtMs: now });
      return { state: "claimed" };
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  try {
    const { data, error } = await admin.rpc("claim_channel_classify_proposal", {
      p_org: input.orgId,
      p_key: input.key,
      p_facts_hash: input.factsHash,
      p_stale_seconds: stale,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable" };
    const row = data as Record<string, unknown>;
    switch (row.state) {
      case "claimed":
        return { state: "claimed" };
      case "in_flight":
        return { state: "in_flight" };
      case "pending":
        return typeof row.approval_id === "string" ? { state: "pending", approvalId: row.approval_id } : { state: "unavailable" };
      case "decided":
        return typeof row.approval_id === "string"
          ? { state: "decided", approvalId: row.approval_id, status: String(row.status ?? "") }
          : { state: "unavailable" };
      case "denied":
        return { state: "denied" };
      default:
        return { state: "unavailable" };
    }
  } catch {
    return { state: "unavailable" };
  }
}

export async function attachChannelClassifyProposal(input: { orgId: string; key: string; approvalId: string }): Promise<boolean> {
  if (!input.orgId || !PROPOSAL_KEY_RE.test(input.key) || !input.approvalId) return false;
  if (isDemoMode()) {
    return serialize(async () => {
      const k = dk(input.orgId, input.key);
      const row = demoProposals.get(k);
      if (!row || row.approvalId) return false;
      if (!(await getApprovalById(input.approvalId, input.orgId))) return false;
      row.approvalId = input.approvalId;
      return true;
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.rpc("attach_channel_classify_proposal", {
      p_org: input.orgId,
      p_key: input.key,
      p_approval: input.approvalId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function releaseChannelClassifyProposal(input: { orgId: string; key: string }): Promise<boolean> {
  if (!input.orgId || !PROPOSAL_KEY_RE.test(input.key)) return false;
  if (isDemoMode()) {
    return serialize(() => {
      const k = dk(input.orgId, input.key);
      const row = demoProposals.get(k);
      if (!row || row.approvalId) return false;
      demoProposals.delete(k);
      return true;
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.rpc("release_channel_classify_proposal", { p_org: input.orgId, p_key: input.key });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function takeChannelStuckNoticeSlot(input: {
  orgId: string;
  key: string;
  windowSeconds: number;
  nowMs?: number;
}): Promise<NoticeSlot> {
  const windowSeconds = Math.floor(input.windowSeconds);
  if (!input.orgId || !NOTICE_KEY_RE.test(input.key) || !(windowSeconds >= 60 && windowSeconds <= 604_800)) {
    return { state: "denied" };
  }
  if (isDemoMode()) {
    return serialize((): NoticeSlot => {
      const k = dk(input.orgId, input.key);
      const now = input.nowMs ?? Date.now();
      const row = demoWindows.get(k);
      if (!row || now - row.windowStartMs >= windowSeconds * 1000) {
        demoWindows.set(k, { windowStartMs: now, suppressed: 0 });
        return { state: "ok", allowed: true };
      }
      row.suppressed += 1;
      return { state: "ok", allowed: false };
    });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  try {
    const { data, error } = await admin.rpc("take_channel_stuck_notice", {
      p_org: input.orgId,
      p_key: input.key,
      p_window_seconds: windowSeconds,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable" };
    const row = data as Record<string, unknown>;
    if (row.state === "ok") return { state: "ok", allowed: row.allowed === true };
    if (row.state === "denied") return { state: "denied" };
    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}
