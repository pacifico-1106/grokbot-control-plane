/**
 * Hash-only send ledger for duplicate-reply prevention (conversation tools).
 *
 * Production: table public.comm_reply_send_fingerprints + RPCs
 * claim_comm_reply_send / finish_comm_reply_send (migration 20261004700000,
 * service_role only; anon / authenticated have no access). The claim is atomic
 * per org + employee + conversation (advisory transaction lock), so two
 * concurrent identical sends cannot both be claimed.
 *
 * Rows hold only: org, employee, keyed conversation hash, keyed body hash,
 * keyed MinHash sketch, tool, approval id, state, timestamps. Never the body.
 * Any store error → { state: "unavailable" } and callers fail closed.
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { commReplyDedupNow } from "@/lib/comm-reply-dedup/config";
import { compareFingerprints, sketchSimilarity } from "@/lib/comm-reply-dedup/fingerprint";

export type CommReplySendRow = {
  id: string;
  orgId: string;
  employeeId: string;
  conversationKey: string;
  bodyHash: string;
  sketch: number[] | null;
  tool: string;
  approvalId: string | null;
  state: "reserved" | "sent" | "uncertain";
  createdAtMs: number;
};

export type CommReplyClaimInput = {
  orgId: string;
  employeeId: string;
  conversationKey: string;
  bodyHash: string;
  sketch: number[] | null;
  tool: string;
  /**
   * Set when fulfilling an approval: a row created after the approval with the
   * same / a similar body (same criterion as duplicates) → superseded.
   */
  approvalId?: string | null;
  /** Demo store only (production reads approval_requests.created_at itself). */
  approvalCreatedAt?: string | null;
  windowSeconds: number;
  /** null = exact match only. */
  similarityThreshold: number | null;
  retentionSeconds: number;
};

export type CommReplyDuplicate = {
  state: "duplicate";
  match: "exact" | "similar";
  similarity: number;
  matchedAt: string;
};

export type CommReplyClaimResult =
  | { state: "claimed"; id: string }
  | CommReplyDuplicate
  | { state: "superseded"; repliedAt: string; match: "exact" | "similar"; similarity: number }
  | { state: "denied" }
  | { state: "unavailable"; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;

function validInput(input: Pick<CommReplyClaimInput, "orgId" | "employeeId" | "conversationKey" | "bodyHash">): boolean {
  return Boolean(input.orgId && input.employeeId && HEX64.test(input.conversationKey) && HEX64.test(input.bodyHash));
}

// ---------------------------------------------------------------- demo store
const demoRows: CommReplySendRow[] = [];
let demoChain: Promise<unknown> = Promise.resolve();

export function resetDemoCommReplySends(): void {
  demoRows.length = 0;
}

export function demoCommReplySendsForTests(): CommReplySendRow[] {
  return demoRows.map((row) => ({ ...row, sketch: row.sketch ? [...row.sketch] : null }));
}

function demoMatch(
  input: Pick<CommReplyClaimInput, "orgId" | "employeeId" | "conversationKey" | "bodyHash" | "sketch" | "windowSeconds" | "similarityThreshold">,
  nowMs: number
): CommReplyDuplicate | null {
  const since = nowMs - input.windowSeconds * 1000;
  const rows = demoRows
    .filter(
      (r) =>
        r.orgId === input.orgId &&
        r.employeeId === input.employeeId &&
        r.conversationKey === input.conversationKey &&
        r.createdAtMs >= since
    )
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const exact = rows.find((r) => r.bodyHash === input.bodyHash);
  if (exact) return { state: "duplicate", match: "exact", similarity: 1, matchedAt: new Date(exact.createdAtMs).toISOString() };
  if (input.similarityThreshold == null || !input.sketch) return null;
  let best: { row: CommReplySendRow; sim: number } | null = null;
  for (const row of rows) {
    const sim = sketchSimilarity(input.sketch, row.sketch);
    if (sim >= input.similarityThreshold && (!best || sim > best.sim)) best = { row, sim };
  }
  return best
    ? { state: "duplicate", match: "similar", similarity: best.sim, matchedAt: new Date(best.row.createdAtMs).toISOString() }
    : null;
}

function demoClaim(input: CommReplyClaimInput): CommReplyClaimResult {
  const nowMs = commReplyDedupNow();
  const cutoff = nowMs - input.retentionSeconds * 1000;
  for (let i = demoRows.length - 1; i >= 0; i--) if (demoRows[i].createdAtMs < cutoff) demoRows.splice(i, 1);
  if (input.approvalId) {
    const createdMs = input.approvalCreatedAt ? Date.parse(input.approvalCreatedAt) : NaN;
    if (!Number.isFinite(createdMs)) return { state: "denied" };
    const after = demoRows
      .filter(
        (r) =>
          r.orgId === input.orgId &&
          r.employeeId === input.employeeId &&
          r.conversationKey === input.conversationKey &&
          r.approvalId !== input.approvalId &&
          r.createdAtMs > createdMs
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    // Same order as the RPC: earliest identical row, else the most similar one.
    const exact = after.find((r) => r.bodyHash === input.bodyHash);
    if (exact) {
      return { state: "superseded", repliedAt: new Date(exact.createdAtMs).toISOString(), match: "exact", similarity: 1 };
    }
    let best: { row: CommReplySendRow; similarity: number } | null = null;
    for (const row of after) {
      const m = compareFingerprints(input, row, input.similarityThreshold);
      if (m && (!best || m.similarity > best.similarity)) best = { row, similarity: m.similarity };
    }
    if (best) {
      return {
        state: "superseded",
        repliedAt: new Date(best.row.createdAtMs).toISOString(),
        match: "similar",
        similarity: best.similarity,
      };
    }
  }
  const dup = demoMatch(input, nowMs);
  if (dup) return dup;
  const id = randomUUID();
  demoRows.push({
    id,
    orgId: input.orgId,
    employeeId: input.employeeId,
    conversationKey: input.conversationKey,
    bodyHash: input.bodyHash,
    sketch: input.sketch ? [...input.sketch] : null,
    tool: input.tool,
    approvalId: input.approvalId ?? null,
    state: "reserved",
    createdAtMs: nowMs,
  });
  return { state: "claimed", id };
}

// ---------------------------------------------------------------- API
export async function claimCommReplySend(input: CommReplyClaimInput): Promise<CommReplyClaimResult> {
  if (!validInput(input)) return { state: "denied" };
  if (isDemoMode()) {
    // Serialize like the DB advisory lock does.
    const run = demoChain.then(() => demoClaim(input));
    demoChain = run.catch(() => undefined);
    return run;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable", reason: "store_unavailable" };
  try {
    const { data, error } = await admin.rpc("claim_comm_reply_send", {
      p_org: input.orgId,
      p_employee: input.employeeId,
      p_conversation_key: input.conversationKey,
      p_body_hash: input.bodyHash,
      p_sketch: input.sketch,
      p_tool: input.tool,
      p_approval: input.approvalId ?? null,
      p_window_seconds: Math.max(1, Math.floor(input.windowSeconds)),
      p_similarity: input.similarityThreshold,
      p_retention_seconds: Math.max(1, Math.floor(input.retentionSeconds)),
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable", reason: "claim_failed" };
    const row = data as Record<string, unknown>;
    switch (row.state) {
      case "claimed":
        return typeof row.id === "string" ? { state: "claimed", id: row.id } : { state: "unavailable", reason: "claim_failed" };
      case "duplicate":
        return {
          state: "duplicate",
          match: row.match === "similar" ? "similar" : "exact",
          similarity: typeof row.similarity === "number" ? row.similarity : 1,
          matchedAt: String(row.matched_at ?? ""),
        };
      case "superseded":
        return {
          state: "superseded",
          repliedAt: String(row.replied_at ?? ""),
          match: row.match === "similar" ? "similar" : "exact",
          similarity: typeof row.similarity === "number" ? row.similarity : 1,
        };
      case "denied":
        return { state: "denied" };
      default:
        return { state: "unavailable", reason: "claim_failed" };
    }
  } catch {
    return { state: "unavailable", reason: "claim_failed" };
  }
}

/** Read-only pre-check (before approval gates). Never writes. */
export async function findRecentCommReplyDuplicate(
  input: Omit<CommReplyClaimInput, "approvalId" | "approvalCreatedAt" | "tool" | "retentionSeconds">
): Promise<{ state: "none" } | CommReplyDuplicate | { state: "unavailable"; reason: string }> {
  if (!validInput(input)) return { state: "none" };
  if (isDemoMode()) return demoMatch(input, commReplyDedupNow()) ?? { state: "none" };
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable", reason: "store_unavailable" };
  try {
    const since = new Date(Date.now() - input.windowSeconds * 1000).toISOString();
    const { data, error } = await admin
      .from("comm_reply_send_fingerprints")
      .select("body_hash, sketch, created_at")
      .eq("org_id", input.orgId)
      .eq("employee_id", input.employeeId)
      .eq("conversation_key", input.conversationKey)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { state: "unavailable", reason: "lookup_failed" };
    const rows = (data ?? []) as Array<{ body_hash: string; sketch: number[] | null; created_at: string }>;
    const exact = rows.find((r) => r.body_hash === input.bodyHash);
    if (exact) return { state: "duplicate", match: "exact", similarity: 1, matchedAt: exact.created_at };
    if (input.similarityThreshold == null || !input.sketch) return { state: "none" };
    let best: { at: string; sim: number } | null = null;
    for (const row of rows) {
      const sim = sketchSimilarity(input.sketch, row.sketch);
      if (sim >= input.similarityThreshold && (!best || sim > best.sim)) best = { at: row.created_at, sim };
    }
    return best ? { state: "duplicate", match: "similar", similarity: best.sim, matchedAt: best.at } : { state: "none" };
  } catch {
    return { state: "unavailable", reason: "lookup_failed" };
  }
}

/** failed → the claim is released (a retry is not a duplicate); sent / uncertain → kept. */
export async function finishCommReplySend(input: {
  id: string;
  orgId: string;
  outcome: "sent" | "failed" | "uncertain";
}): Promise<void> {
  if (isDemoMode()) {
    const idx = demoRows.findIndex((r) => r.id === input.id && r.orgId === input.orgId);
    if (idx < 0) return;
    if (input.outcome === "failed") demoRows.splice(idx, 1);
    else demoRows[idx] = { ...demoRows[idx], state: input.outcome };
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  try {
    await admin.rpc("finish_comm_reply_send", { p_id: input.id, p_org: input.orgId, p_outcome: input.outcome });
  } catch {
    // Best effort: a stuck reserved row only over-suppresses (fail closed) until the window passes.
  }
}
