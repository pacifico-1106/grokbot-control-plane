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
  /** v2 (migration 20261005300000): channel-level key (no thread) and job key. */
  channelKey?: string | null;
  jobKey?: string | null;
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

// ------------------------------------------------- duplicate post guard v2
// RPC claim_outbound_send_v2 / release_uncertain_outbound_send (migration
// 20261005300000, service_role only). Used only with DUPLICATE_GUARD_V2_ENABLED.

export type DuplicateScope = "same_conversation" | "cross_thread" | "cross_employee" | "same_job";
export type CrossEmployeeMode = "off" | "warn" | "block";

export type OutboundClaimV2Input = {
  orgId: string;
  employeeId: string;
  conversationKey: string;
  channelKey: string;
  jobKey: string | null;
  bodyHash: string;
  sketch: number[] | null;
  tool: string;
  approvalId?: string | null;
  /** Demo store only (production reads approval_requests.created_at itself). */
  approvalCreatedAt?: string | null;
  windowSeconds: number;
  similarityThreshold: number | null;
  retentionSeconds: number;
  crossThread: boolean;
  crossEmployee: CrossEmployeeMode;
  dryRun: boolean;
};

export type CrossEmployeeWarning = {
  scope: "cross_employee";
  match: "exact" | "similar";
  similarity: number;
  matchedAt: string;
};

export type OutboundDuplicate = {
  state: "duplicate";
  scope: DuplicateScope;
  match: "exact" | "similar";
  similarity: number;
  matchedAt: string;
  matchedState: "reserved" | "sent" | "uncertain";
  /** Only for the caller's own uncertain row (release after verification). */
  matchedId?: string;
};

export type OutboundClaimV2Result =
  | { state: "claimed"; id: string; warning?: CrossEmployeeWarning }
  | { state: "none"; warning?: CrossEmployeeWarning }
  | OutboundDuplicate
  | { state: "superseded"; repliedAt: string; match: "exact" | "similar"; similarity: number }
  | { state: "denied" }
  | { state: "unavailable"; reason: string };

const CLAIM_V2_TOOLS = new Set(["comm.reply", "comm.send", "slack.post", "slack.post_external", "sns.publish"]);

function validV2Input(input: OutboundClaimV2Input): boolean {
  return Boolean(
    validInput(input) &&
      HEX64.test(input.channelKey) &&
      (input.jobKey == null || HEX64.test(input.jobKey)) &&
      CLAIM_V2_TOOLS.has(input.tool) &&
      ["off", "warn", "block"].includes(input.crossEmployee) &&
      input.windowSeconds >= 1 &&
      input.windowSeconds <= 604800 &&
      input.retentionSeconds >= input.windowSeconds &&
      input.retentionSeconds <= 2592000
  );
}

function demoSim(input: Pick<OutboundClaimV2Input, "bodyHash" | "sketch" | "similarityThreshold">, row: CommReplySendRow): number {
  if (row.bodyHash === input.bodyHash) return 1;
  if (input.similarityThreshold == null || !input.sketch) return 0;
  const sim = sketchSimilarity(input.sketch, row.sketch);
  return sim >= input.similarityThreshold ? sim : 0;
}

/** Same semantics and order as the SQL function (tests/security/db-duplicate-guard-v2.sql). */
function demoClaimV2(input: OutboundClaimV2Input): OutboundClaimV2Result {
  const nowMs = commReplyDedupNow();
  if (!input.dryRun) {
    const cutoff = nowMs - input.retentionSeconds * 1000;
    for (let i = demoRows.length - 1; i >= 0; i--) if (demoRows[i].createdAtMs < cutoff) demoRows.splice(i, 1);
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const dup = (row: CommReplySendRow, sim: number, scope: DuplicateScope): OutboundDuplicate => ({
    state: "duplicate",
    scope,
    match: row.bodyHash === input.bodyHash ? "exact" : "similar",
    similarity: sim,
    matchedAt: iso(row.createdAtMs),
    matchedState: row.state,
    ...(row.state === "uncertain" && row.employeeId === input.employeeId ? { matchedId: row.id } : {}),
  });
  const orgRows = demoRows.filter((r) => r.orgId === input.orgId);

  // a. same job, any age
  if (input.jobKey) {
    let best: { row: CommReplySendRow; sim: number } | null = null;
    for (const row of orgRows) {
      if (row.employeeId !== input.employeeId || row.jobKey !== input.jobKey || row.channelKey !== input.channelKey) continue;
      if (input.approvalId && row.approvalId === input.approvalId) continue;
      const sim = demoSim(input, row);
      if (sim > 0 && (!best || sim > best.sim)) best = { row, sim };
    }
    if (best) return dup(best.row, best.sim, "same_job");
  }

  // b. after the approval
  let approvalCreatedMs: number | null = null;
  if (input.approvalId) {
    approvalCreatedMs = input.approvalCreatedAt ? Date.parse(input.approvalCreatedAt) : NaN;
    if (!Number.isFinite(approvalCreatedMs)) return { state: "denied" };
    const after = orgRows
      .filter(
        (r) =>
          (r.employeeId === input.employeeId || input.crossEmployee === "block") &&
          (r.conversationKey === input.conversationKey || (input.crossThread && r.channelKey === input.channelKey)) &&
          r.createdAtMs > (approvalCreatedMs as number) &&
          r.approvalId !== input.approvalId
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    let best: { row: CommReplySendRow; sim: number } | null = null;
    for (const row of after) {
      const sim = demoSim(input, row);
      if (sim <= 0) continue;
      if (!best || sim > best.sim || (sim === best.sim && row.state === "uncertain" && row.employeeId === input.employeeId)) {
        best = { row, sim };
      }
    }
    if (best) {
      if (best.row.state === "uncertain") {
        const scope: DuplicateScope =
          best.row.employeeId !== input.employeeId
            ? "cross_employee"
            : best.row.conversationKey === input.conversationKey
              ? "same_conversation"
              : "cross_thread";
        return dup(best.row, best.sim, scope);
      }
      return {
        state: "superseded",
        repliedAt: iso(best.row.createdAtMs),
        match: best.row.bodyHash === input.bodyHash ? "exact" : "similar",
        similarity: best.sim,
      };
    }
  }

  // c / d. window
  let since = nowMs - input.windowSeconds * 1000;
  if (approvalCreatedMs != null) since = Math.min(since, approvalCreatedMs - input.windowSeconds * 1000);
  let best: { row: CommReplySendRow; sim: number; rank: number } | null = null;
  let warning: CrossEmployeeWarning | undefined;
  const rows = orgRows.filter((r) => r.createdAtMs >= since).sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const row of rows) {
    const sameConv = row.conversationKey === input.conversationKey;
    if (!sameConv && !(input.crossThread && row.channelKey === input.channelKey)) continue;
    const sim = demoSim(input, row);
    if (sim <= 0) continue;
    let rank: number;
    if (row.employeeId !== input.employeeId) {
      if (input.crossEmployee === "off") continue;
      if (input.crossEmployee === "warn") {
        if (!warning || sim > warning.similarity) {
          warning = { scope: "cross_employee", match: row.bodyHash === input.bodyHash ? "exact" : "similar", similarity: sim, matchedAt: iso(row.createdAtMs) };
        }
        continue;
      }
      rank = 3;
    } else {
      rank = sameConv ? 1 : 2;
    }
    if (!best || rank < best.rank || (rank === best.rank && sim > best.sim)) best = { row, sim, rank };
  }
  if (best) return dup(best.row, best.sim, best.rank === 1 ? "same_conversation" : best.rank === 2 ? "cross_thread" : "cross_employee");

  if (input.dryRun) return warning ? { state: "none", warning } : { state: "none" };
  const id = randomUUID();
  demoRows.push({
    id,
    orgId: input.orgId,
    employeeId: input.employeeId,
    conversationKey: input.conversationKey,
    channelKey: input.channelKey,
    jobKey: input.jobKey,
    bodyHash: input.bodyHash,
    sketch: input.sketch ? [...input.sketch] : null,
    tool: input.tool,
    approvalId: input.approvalId ?? null,
    state: "reserved",
    createdAtMs: nowMs,
  });
  return warning ? { state: "claimed", id, warning } : { state: "claimed", id };
}

function parseWarning(raw: unknown): CrossEmployeeWarning | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  return {
    scope: "cross_employee",
    match: w.match === "similar" ? "similar" : "exact",
    similarity: typeof w.similarity === "number" ? w.similarity : 1,
    matchedAt: String(w.matched_at ?? ""),
  };
}

const SCOPES: readonly DuplicateScope[] = ["same_conversation", "cross_thread", "cross_employee", "same_job"];

/** Atomic v2 claim (or read-only dry run). Store / RPC error → unavailable (callers fail closed). */
export async function claimOutboundSendV2(input: OutboundClaimV2Input): Promise<OutboundClaimV2Result> {
  if (!validV2Input(input)) return { state: "denied" };
  if (isDemoMode()) {
    const run = demoChain.then(() => demoClaimV2(input));
    demoChain = run.catch(() => undefined);
    return run;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable", reason: "store_unavailable" };
  try {
    const { data, error } = await admin.rpc("claim_outbound_send_v2", {
      p_org: input.orgId,
      p_employee: input.employeeId,
      p_conversation_key: input.conversationKey,
      p_channel_key: input.channelKey,
      p_job_key: input.jobKey,
      p_body_hash: input.bodyHash,
      p_sketch: input.sketch,
      p_tool: input.tool,
      p_approval: input.approvalId ?? null,
      p_window_seconds: Math.max(1, Math.floor(input.windowSeconds)),
      p_similarity: input.similarityThreshold,
      p_retention_seconds: Math.max(1, Math.floor(input.retentionSeconds)),
      p_cross_thread: input.crossThread,
      p_cross_employee: input.crossEmployee,
      p_dry_run: input.dryRun,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable", reason: "claim_failed" };
    const row = data as Record<string, unknown>;
    const warning = parseWarning(row.warning);
    switch (row.state) {
      case "claimed":
        if (typeof row.id !== "string") return { state: "unavailable", reason: "claim_failed" };
        return warning ? { state: "claimed", id: row.id, warning } : { state: "claimed", id: row.id };
      case "none":
        return warning ? { state: "none", warning } : { state: "none" };
      case "duplicate": {
        const scope = SCOPES.includes(row.scope as DuplicateScope) ? (row.scope as DuplicateScope) : "same_conversation";
        const matchedState = row.matched_state === "uncertain" || row.matched_state === "reserved" ? row.matched_state : "sent";
        return {
          state: "duplicate",
          scope,
          match: row.match === "similar" ? "similar" : "exact",
          similarity: typeof row.similarity === "number" ? row.similarity : 1,
          matchedAt: String(row.matched_at ?? ""),
          matchedState,
          ...(typeof row.matched_id === "string" ? { matchedId: row.matched_id } : {}),
        };
      }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller verified that an earlier post with an unknown outcome is absent:
 * delete that one uncertain row, only when it belongs to the same org +
 * employee. released=false for anything else (the following claim still sees
 * the row and blocks).
 */
export async function releaseUncertainOutboundSend(input: {
  id: string;
  orgId: string;
  employeeId: string;
}): Promise<{ released: boolean } | { state: "unavailable"; reason: string }> {
  if (!UUID_RE.test(input.id) || !input.orgId || !input.employeeId) return { released: false };
  if (isDemoMode()) {
    const run = demoChain.then(() => {
      const idx = demoRows.findIndex(
        (r) => r.id === input.id && r.orgId === input.orgId && r.employeeId === input.employeeId && r.state === "uncertain"
      );
      if (idx < 0) return { released: false };
      demoRows.splice(idx, 1);
      return { released: true };
    });
    demoChain = run.catch(() => undefined);
    return run;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable", reason: "store_unavailable" };
  try {
    const { data, error } = await admin.rpc("release_uncertain_outbound_send", {
      p_id: input.id,
      p_org: input.orgId,
      p_employee: input.employeeId,
    });
    if (error) return { state: "unavailable", reason: "release_failed" };
    return { released: data === true };
  } catch {
    return { state: "unavailable", reason: "release_failed" };
  }
}

/**
 * v1 (COMM_REPLY_DEDUP_ENABLED without v2): read-only, best-effort lookup of
 * ANOTHER employee's same / similar post to the same conversation in the window.
 * Used only to warn + audit (v1 never blocks on it), so an error → null.
 */
export async function findCrossEmployeeDuplicateV1(
  input: Omit<CommReplyClaimInput, "approvalId" | "approvalCreatedAt" | "tool" | "retentionSeconds">
): Promise<CrossEmployeeWarning | null> {
  if (!validInput(input)) return null;
  const pick = (rows: Array<{ bodyHash: string; sketch: number[] | null; at: string }>): CrossEmployeeWarning | null => {
    let best: CrossEmployeeWarning | null = null;
    for (const row of rows) {
      const m = compareFingerprints(input, row, input.similarityThreshold);
      if (m && (!best || m.similarity > best.similarity)) best = { scope: "cross_employee", match: m.match, similarity: m.similarity, matchedAt: row.at };
    }
    return best;
  };
  if (isDemoMode()) {
    const since = commReplyDedupNow() - input.windowSeconds * 1000;
    return pick(
      demoRows
        .filter((r) => r.orgId === input.orgId && r.employeeId !== input.employeeId && r.conversationKey === input.conversationKey && r.createdAtMs >= since)
        .map((r) => ({ bodyHash: r.bodyHash, sketch: r.sketch, at: new Date(r.createdAtMs).toISOString() }))
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  try {
    const since = new Date(Date.now() - input.windowSeconds * 1000).toISOString();
    const { data, error } = await admin
      .from("comm_reply_send_fingerprints")
      .select("body_hash, sketch, created_at")
      .eq("org_id", input.orgId)
      .neq("employee_id", input.employeeId)
      .eq("conversation_key", input.conversationKey)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return null;
    const rows = (data ?? []) as Array<{ body_hash: string; sketch: number[] | null; created_at: string }>;
    return pick(rows.map((r) => ({ bodyHash: r.body_hash, sketch: r.sketch, at: r.created_at })));
  } catch {
    return null;
  }
}
