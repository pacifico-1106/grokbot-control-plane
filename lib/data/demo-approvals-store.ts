/**
 * Durable DEMO approvals store for Vercel multi-isolate.
 *
 * Priority:
 * 1. Upstash Redis REST (UPSTASH_REDIS_REST_URL + TOKEN)
 *    or Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN) — same REST shape
 * 2. GitHub Contents API on branch `demo-store` (DEMO_APPROVALS_GITHUB_TOKEN)
 * 3. Generic HTTP JSON store (APPROVAL_DEMO_STORE_URL + APPROVAL_DEMO_STORE_TOKEN)
 * 4. In-memory (process-local; seeds + live tickets do NOT cross isolates)
 */

import {
  DEMO_APPROVALS,
  DEMO_ORG,
  getRuntimeApprovals,
  pushRuntimeApproval,
  pushRuntimeAuditEvent,
  resolveRuntimeApproval,
  type CreateRuntimeApprovalInput,
} from "../demo-data";
import {
  buildPollPath,
  generateStatusToken,
  generateTelegramRef,
} from "../approvals/tokens";
import type { ApprovalRequest } from "../types";

const REDIS_KEY = "staffpass:demo:approvals:v1";

export type DemoApprovalsBackend = "upstash" | "github" | "http" | "memory";

function redisUrl(): string {
  return (
    process.env.UPSTASH_REDIS_REST_URL?.trim() ||
    process.env.KV_REST_API_URL?.trim() ||
    ""
  );
}

function redisToken(): string {
  return (
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
    process.env.KV_REST_API_TOKEN?.trim() ||
    ""
  );
}

function httpStoreUrl(): string {
  return process.env.APPROVAL_DEMO_STORE_URL?.trim() || "";
}

function httpStoreToken(): string {
  return process.env.APPROVAL_DEMO_STORE_TOKEN?.trim() || "";
}

function githubToken(): string {
  return (
    process.env.DEMO_APPROVALS_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    ""
  );
}

function githubRepo(): string {
  return (
    process.env.DEMO_APPROVALS_GITHUB_REPO?.trim() ||
    "pacifico-1106/grokbot-control-plane"
  );
}

const GITHUB_BRANCH = "demo-store";
const GITHUB_PATH = "approvals.json";

export function getDemoApprovalsBackend(): DemoApprovalsBackend {
  if (redisUrl() && redisToken()) return "upstash";
  if (githubToken()) return "github";
  if (httpStoreUrl()) return "http";
  return "memory";
}

export function isDurableDemoApprovalsStore(): boolean {
  return getDemoApprovalsBackend() !== "memory";
}

function cloneSeeds(): ApprovalRequest[] {
  return DEMO_APPROVALS.map((a) => ({ ...a }));
}

function normalizeStoredApproval(row: ApprovalRequest): ApprovalRequest {
  return {
    ...row,
    revisionNote: row.revisionNote ?? null,
    revisionCount: Number.isFinite(row.revisionCount) ? row.revisionCount : 0,
    parentApprovalId: row.parentApprovalId ?? null,
    telegramRef: row.telegramRef ?? null,
    telegramMessageId: Number.isSafeInteger(row.telegramMessageId)
      ? row.telegramMessageId
      : null,
    metadata: row.metadata ?? {},
  };
}

function mergeSeedAndStored(stored: ApprovalRequest[]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const s of cloneSeeds()) byId.set(s.id, normalizeStoredApproval(s));
  for (const row of stored) {
    if (!row?.id) continue;
    byId.set(row.id, normalizeStoredApproval(row));
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

function rowsForDurablePersist(rows: ApprovalRequest[]): ApprovalRequest[] {
  const seedById = new Map(DEMO_APPROVALS.map((s) => [s.id, s]));
  return rows.filter((r) => {
    const seed = seedById.get(r.id);
    if (!seed) return true;
    return (
      r.status !== seed.status ||
      r.jobId !== seed.jobId ||
      r.statusToken !== seed.statusToken ||
      r.summary !== seed.summary ||
      Boolean(r.resolvedAt)
    );
  });
}

async function redisCommand<T>(
  command: unknown[]
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const url = redisUrl();
  const token = redisToken();
  if (!url || !token) return { ok: false, error: "redis_not_configured" };
  try {
    const res = await fetch(url.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `redis_http_${res.status}:${text.slice(0, 120)}`,
      };
    }
    const data = (await res.json()) as { result?: T; error?: string };
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, result: data.result as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "redis_fetch_failed",
    };
  }
}

async function redisGetMap(): Promise<ApprovalRequest[] | null> {
  const got = await redisCommand<string | null>(["GET", REDIS_KEY]);
  if (!got.ok) return null;
  const raw = got.result;
  if (raw == null || raw === "") return [];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as
      | { approvals?: ApprovalRequest[] }
      | ApprovalRequest[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.approvals) ? parsed.approvals : [];
  } catch {
    return [];
  }
}

async function redisSetMap(rows: ApprovalRequest[]): Promise<boolean> {
  const payload = JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString(),
    approvals: rows,
  });
  const set = await redisCommand<string>(["SET", REDIS_KEY, payload]);
  return set.ok;
}

async function httpGetMap(): Promise<ApprovalRequest[] | null> {
  const url = httpStoreUrl();
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(httpStoreToken()
          ? { Authorization: `Bearer ${httpStoreToken()}` }
          : {}),
      },
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const parsed = (await res.json()) as
      | { approvals?: ApprovalRequest[] }
      | ApprovalRequest[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.approvals) ? parsed.approvals : [];
  } catch {
    return null;
  }
}

async function httpSetMap(rows: ApprovalRequest[]): Promise<boolean> {
  const url = httpStoreUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(httpStoreToken()
          ? { Authorization: `Bearer ${httpStoreToken()}` }
          : {}),
      },
      body: JSON.stringify({
        v: 1,
        updatedAt: new Date().toISOString(),
        approvals: rows,
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}


async function githubGetMap(): Promise<ApprovalRequest[] | null> {
  const token = githubToken();
  const repo = githubRepo();
  if (!token || !repo) return null;
  const url = `https://api.github.com/repos/${repo}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "staffpass-demo-approvals",
      },
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: string; encoding?: string };
    if (!body.content) return [];
    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as
      | { approvals?: ApprovalRequest[] }
      | ApprovalRequest[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.approvals) ? parsed.approvals : [];
  } catch {
    return null;
  }
}

async function githubSetMap(rows: ApprovalRequest[]): Promise<boolean> {
  const token = githubToken();
  const repo = githubRepo();
  if (!token || !repo) return false;
  const metaUrl = `https://api.github.com/repos/${repo}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "staffpass-demo-approvals",
    "Content-Type": "application/json",
  };
  try {
    let sha: string | undefined;
    const meta = await fetch(metaUrl, { headers, cache: "no-store" });
    if (meta.ok) {
      const m = (await meta.json()) as { sha?: string };
      sha = m.sha;
    } else if (meta.status !== 404) {
      return false;
    }
    const payload = {
      v: 1,
      updatedAt: new Date().toISOString(),
      approvals: rows,
    };
    const content = Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString(
      "base64"
    );
    const put = await fetch(
      `https://api.github.com/repos/${repo}/contents/${GITHUB_PATH}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message: `demo-approvals: sync ${rows.length} row(s)`,
          content,
          branch: GITHUB_BRANCH,
          ...(sha ? { sha } : {}),
        }),
        cache: "no-store",
      }
    );
    return put.ok;
  } catch {
    return false;
  }
}

async function loadDurableRows(): Promise<ApprovalRequest[] | null> {
  const backend = getDemoApprovalsBackend();
  if (backend === "upstash") return redisGetMap();
  if (backend === "github") return githubGetMap();
  if (backend === "http") return httpGetMap();
  return null;
}

async function saveDurableRows(rows: ApprovalRequest[]): Promise<boolean> {
  const backend = getDemoApprovalsBackend();
  const toStore = rowsForDurablePersist(rows);
  if (backend === "upstash") return redisSetMap(toStore);
  if (backend === "github") return githubSetMap(toStore);
  if (backend === "http") return httpSetMap(toStore);
  return false;
}

function syncMemoryFromRows(rows: ApprovalRequest[]) {
  const runtime = getRuntimeApprovals();
  runtime.splice(0, runtime.length, ...rows.map((r) => ({ ...r })));
}

/** List approvals: durable map merged with seeds, else in-memory runtime. */
export async function demoListApprovals(): Promise<ApprovalRequest[]> {
  if (!isDurableDemoApprovalsStore()) {
    return getRuntimeApprovals().map((a) => ({ ...a }));
  }
  const stored = await loadDurableRows();
  if (stored == null) {
    return getRuntimeApprovals().map((a) => ({ ...a }));
  }
  const merged = mergeSeedAndStored(stored);
  syncMemoryFromRows(merged);
  return merged;
}

export async function demoGetApproval(
  id: string
): Promise<ApprovalRequest | null> {
  if (!id) return null;
  const rows = await demoListApprovals();
  return rows.find((a) => a.id === id) ?? null;
}

export async function demoUpdateApproval(
  id: string,
  patch: Partial<ApprovalRequest>
): Promise<ApprovalRequest | null> {
  if (!id) return null;
  if (!isDurableDemoApprovalsStore()) {
    const rows = getRuntimeApprovals();
    const idx = rows.findIndex((row) => row.id === id);
    if (idx < 0) return null;
    rows[idx] = { ...rows[idx], ...patch };
    return { ...rows[idx] };
  }

  const stored = (await loadDurableRows()) ?? [];
  const merged = mergeSeedAndStored(stored);
  const idx = merged.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  const updated = { ...merged[idx], ...patch };
  const next = [...merged];
  next[idx] = updated;
  if (!(await saveDurableRows(next))) return null;
  syncMemoryFromRows(next);
  return updated;
}

export async function demoCreateApproval(
  input: CreateRuntimeApprovalInput
): Promise<ApprovalRequest> {
  if (!isDurableDemoApprovalsStore()) {
    return pushRuntimeApproval(input);
  }

  const stored = (await loadDurableRows()) ?? [];
  const merged = mergeSeedAndStored(stored);
  const statusToken = input.statusToken || generateStatusToken();
  const id = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const row: ApprovalRequest = {
    id,
    orgId: DEMO_ORG.id,
    employeeId: input.employeeId,
    credentialId: input.credentialId,
    title: input.title,
    purpose: input.purpose,
    summary: input.summary,
    risk: input.risk,
    status: "pending",
    tool: input.tool ?? null,
    jobId: input.jobId ?? null,
    revisionNote: null,
    revisionCount: input.revisionCount ?? 0,
    parentApprovalId: input.parentApprovalId ?? null,
    telegramRef: input.telegramRef || generateTelegramRef(),
    telegramMessageId: null,
    metadata: input.metadata ?? {},
    statusToken,
    pollPath: buildPollPath(id, statusToken),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };

  const next = [row, ...merged.filter((a) => a.id !== row.id)];
  const ok = await saveDurableRows(next);
  if (!ok) {
    return pushRuntimeApproval({ ...input, statusToken });
  }
  syncMemoryFromRows(next);
  pushRuntimeAuditEvent({
    orgId: DEMO_ORG.id,
    employeeId: row.employeeId,
    credentialId: row.credentialId,
    action: "approval.requested",
    purpose: row.purpose,
    summary: `承認待ち: ${row.title}`,
    metadata: {
      approvalId: row.id,
      tool: row.tool,
      jobId: row.jobId,
      risk: row.risk,
      pollPath: row.pollPath,
      durable: true,
    },
  });
  return row;
}

export async function demoResolveApproval(
  id: string,
  status: "approved" | "rejected" | "revision_requested",
  resolvedBy: string,
  revisionNote?: string
): Promise<ApprovalRequest | null> {
  if (!isDurableDemoApprovalsStore()) {
    return resolveRuntimeApproval(id, status, resolvedBy, revisionNote);
  }

  const stored = (await loadDurableRows()) ?? [];
  const merged = mergeSeedAndStored(stored);
  const idx = merged.findIndex((a) => a.id === id);
  if (idx < 0) {
    const mem = resolveRuntimeApproval(id, status, resolvedBy, revisionNote);
    if (!mem) return null;
    const again = mergeSeedAndStored([...stored, mem]);
    await saveDurableRows(again);
    syncMemoryFromRows(again);
    return mem;
  }

  const nextRow: ApprovalRequest = {
    ...merged[idx],
    status,
    revisionNote:
      status === "revision_requested" ? revisionNote?.trim() || null : null,
    revisionCount:
      status === "revision_requested"
        ? merged[idx].revisionCount + 1
        : merged[idx].revisionCount,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  };
  const next = [...merged];
  next[idx] = nextRow;
  const ok = await saveDurableRows(next);
  if (!ok) {
    return resolveRuntimeApproval(id, status, resolvedBy, revisionNote);
  }
  syncMemoryFromRows(next);
  pushRuntimeAuditEvent({
    orgId: DEMO_ORG.id,
    employeeId: nextRow.employeeId,
    credentialId: nextRow.credentialId,
    action:
      status === "revision_requested"
        ? "approval.revision_requested"
        : "approval.resolved",
    purpose: nextRow.purpose,
    summary:
      status === "approved"
        ? `承認: ${nextRow.title || nextRow.summary}`
        : status === "revision_requested"
          ? `修正依頼: ${nextRow.title || nextRow.summary}`
          : `却下: ${nextRow.title || nextRow.summary}`,
    metadata: {
      decision: status,
      resolvedBy,
      tool: nextRow.tool ?? null,
      jobId: nextRow.jobId ?? null,
      durable: true,
    },
  });
  return nextRow;
}
