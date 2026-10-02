/**
 * LP Knowledge Base data layer.
 * Feature flag LP_CHAT_ENABLED must be ON for chat KB search.
 */

import { createSupabaseAdminClient } from "@/lib/supabase";

export interface KbDocument {
  documentId: string;
  documentKey: string;
  title: string;
  sourceUrl: string | null;
  revision: number;
  content: string;
  releaseKey: string;
}

export interface KbRelease {
  releaseId: string;
  releaseKey: string;
  publishedAt: string | null;
  documentCount: number;
}

export interface KbSearchResult {
  releaseId: string;
  releaseKey: string;
  status: "found" | "not_found" | "error";
  passages: KbDocument[];
}

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const SEARCH_OVERFETCH = 4;
const SEARCH_MAX_ROWS = 40;

/**
 * Keep only rows of the latest published release, one passage per document,
 * in the order search_published_kb returned them (title hits first).
 */
export function selectLatestReleasePassages(
  rows: KbDocument[],
  latestReleaseKey: string,
  limit: number
): KbDocument[] {
  const seen = new Set<string>();
  const out: KbDocument[] = [];
  for (const row of rows) {
    if (row.releaseKey !== latestReleaseKey) continue;
    if (seen.has(row.documentId)) continue;
    seen.add(row.documentId);
    out.push(row);
    if (out.length >= Math.max(limit, 1)) break;
  }
  return out;
}

export async function searchKnowledgeBase(
  query: string,
  limit: number = 3
): Promise<KbSearchResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.warn("[kb] Supabase not configured");
    return { releaseId: "", releaseKey: "", status: "error", passages: [] };
  }

  if (!query || query.length > 500) {
    return { releaseId: "", releaseKey: "", status: "not_found", passages: [] };
  }

  try {
    const { data: releaseData } = await admin.rpc("get_published_kb_release", {
      p_tenant_id: DEFAULT_TENANT_ID,
    });

    const release = releaseData?.[0] as Record<string, unknown> | undefined;
    const releaseId = release?.release_id ? String(release.release_id) : "";
    const releaseKey = release?.release_key ? String(release.release_key) : "";

    if (!releaseId) {
      return { releaseId: "", releaseKey: "", status: "not_found", passages: [] };
    }

    // search_published_kb matches revisions of every published release. Only the
    // latest published release (get_published_kb_release) is authoritative, so rows
    // from older releases are dropped here. Over-fetch so dropped rows cannot
    // crowd out current ones while an older release is still marked published.
    const { data, error } = await admin.rpc("search_published_kb", {
      p_query: query,
      p_tenant_id: DEFAULT_TENANT_ID,
      p_limit: Math.min(Math.max(limit, 1) * SEARCH_OVERFETCH, SEARCH_MAX_ROWS),
    });

    if (error) {
      console.error("[kb] Search failed:", error);
      return { releaseId, releaseKey, status: "error", passages: [] };
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      return { releaseId, releaseKey, status: "not_found", passages: [] };
    }

    const passages = selectLatestReleasePassages(
      (data as Record<string, unknown>[]).map((row) => ({
        documentId: String(row.document_id),
        documentKey: String(row.document_key),
        title: String(row.title),
        sourceUrl: row.source_url ? String(row.source_url) : null,
        revision: Number(row.revision),
        content: String(row.content),
        releaseKey: String(row.release_key),
      })),
      releaseKey,
      limit
    );

    if (passages.length === 0) {
      return { releaseId, releaseKey, status: "not_found", passages: [] };
    }

    return { releaseId, releaseKey, status: "found", passages };
  } catch (error) {
    console.error("[kb] Search error:", error);
    return { releaseId: "", releaseKey: "", status: "error", passages: [] };
  }
}

export async function getPublishedRelease(): Promise<KbRelease | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  try {
    const { data, error } = await admin.rpc("get_published_kb_release", {
      p_tenant_id: DEFAULT_TENANT_ID,
    });

    if (error || !data || !Array.isArray(data) || data.length === 0) {
      return null;
    }

    const row = data[0] as Record<string, unknown>;
    return {
      releaseId: String(row.release_id),
      releaseKey: String(row.release_key),
      publishedAt: row.published_at ? String(row.published_at) : null,
      documentCount: Number(row.document_count ?? 0),
    };
  } catch (error) {
    console.error("[kb] Get release error:", error);
    return null;
  }
}

export async function createDraftRevision(input: {
  documentKey: string;
  title: string;
  content: string;
  sourceUrl?: string;
}): Promise<{ documentId: string; revision: number } | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  if (input.content.length > 10000) {
    throw new Error("content_too_long");
  }

  try {
    let documentId: string;

    const { data: existing } = await admin
      .from("lp_kb_documents")
      .select("id")
      .eq("tenant_id", DEFAULT_TENANT_ID)
      .eq("document_key", input.documentKey)
      .maybeSingle();

    if (existing) {
      documentId = String(existing.id);
    } else {
      const { data: newDoc, error: docError } = await admin
        .from("lp_kb_documents")
        .insert({
          tenant_id: DEFAULT_TENANT_ID,
          document_key: input.documentKey,
          title: input.title,
          source_url: input.sourceUrl || null,
          scope: "internal",
        })
        .select("id")
        .single();

      if (docError || !newDoc) {
        throw new Error(docError?.message || "document_create_failed");
      }

      documentId = String(newDoc.id);
    }

    const { count } = await admin
      .from("lp_kb_revisions")
      .select("*", { count: "exact", head: true })
      .eq("document_id", documentId);

    const revision = (count || 0) + 1;
    const contentHash = await hashContent(input.content);

    const { error: revError } = await admin
      .from("lp_kb_revisions")
      .insert({
        document_id: documentId,
        revision,
        content: input.content,
        content_hash: contentHash,
      });

    if (revError) {
      throw new Error(revError.message || "revision_create_failed");
    }

    return { documentId, revision };
  } catch (error) {
    console.error("[kb] Create draft revision failed:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Releases: propose (always_human approval pending) and publish (after approval)
// ---------------------------------------------------------------------------

export interface KbReleaseRow {
  id: string;
  tenantId: string;
  releaseKey: string;
  status: "draft" | "pending_approval" | "published" | "superseded";
  revisionIds: string[];
  supersedes: string | null;
}

export interface KbRevisionRef {
  id: string;
  documentId: string;
  revision: number;
}

export interface KbDocumentRef {
  id: string;
  documentKey: string;
  scope: "public" | "internal" | "quarantined";
}

/** Storage used by propose/publish. Supabase in production, in-memory in tests. */
export interface KbReleaseStore {
  getLatestPublishedRelease(tenantId: string): Promise<KbReleaseRow | null>;
  getRelease(releaseId: string): Promise<KbReleaseRow | null>;
  getRevisions(revisionIds: string[]): Promise<KbRevisionRef[]>;
  getDocuments(documentIds: string[]): Promise<KbDocumentRef[]>;
  insertPendingRelease(input: {
    tenantId: string;
    releaseKey: string;
    revisionIds: string[];
    supersedes: string | null;
  }): Promise<string>;
  /** internal → public only; never touches quarantined. Returns ids changed. */
  markDocumentsPublic(documentIds: string[]): Promise<string[]>;
  /** pending_approval → published. Returns false if the row was not pending. */
  markReleasePublished(releaseId: string, publishedBy: string, at: string): Promise<boolean>;
  /** Every other published release of the tenant → superseded. Returns ids changed. */
  supersedeOtherPublished(tenantId: string, keepReleaseId: string): Promise<string[]>;
}

export type KbReleaseErrorCode =
  | "store_unavailable"
  | "missing_required_fields"
  | "unknown_revision"
  | "duplicate_document"
  | "quarantined_document"
  | "release_not_found"
  | "release_not_pending"
  | "stale_release"
  | "publish_conflict";

export class KbReleaseError extends Error {
  constructor(public readonly code: KbReleaseErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "KbReleaseError";
  }
}

/**
 * Revision set for a new release: the requested revisions plus, for every
 * document of the latest published release that is not being replaced or
 * explicitly removed, its current revision (carry-forward). Pure.
 */
export function buildReleaseRevisionSet(input: {
  requested: KbRevisionRef[];
  latestPublished: Array<KbRevisionRef & { documentKey: string }>;
  removeDocumentKeys?: string[];
}): { revisionIds: string[]; carriedForward: string[]; removed: string[] } {
  const requestedDocs = new Set<string>();
  for (const rev of input.requested) {
    if (requestedDocs.has(rev.documentId)) {
      throw new KbReleaseError("duplicate_document", rev.documentId);
    }
    requestedDocs.add(rev.documentId);
  }
  const remove = new Set(input.removeDocumentKeys ?? []);
  const carriedForward: string[] = [];
  const removed: string[] = [];
  for (const rev of input.latestPublished) {
    if (requestedDocs.has(rev.documentId)) continue;
    if (remove.has(rev.documentKey)) {
      removed.push(rev.id);
      continue;
    }
    requestedDocs.add(rev.documentId);
    carriedForward.push(rev.id);
  }
  return {
    revisionIds: [...input.requested.map((r) => r.id), ...carriedForward],
    carriedForward,
    removed,
  };
}

async function loadRevisions(store: KbReleaseStore, ids: string[]): Promise<KbRevisionRef[]> {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new KbReleaseError("duplicate_document", "repeated revision id");
  const revisions = await store.getRevisions(unique);
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) throw new KbReleaseError("unknown_revision", missing.join(","));
  return unique.map((id) => byId.get(id)!);
}

async function assertNotQuarantined(store: KbReleaseStore, documentIds: string[]): Promise<KbDocumentRef[]> {
  const docs = await store.getDocuments([...new Set(documentIds)]);
  const quarantined = docs.filter((d) => d.scope === "quarantined");
  if (quarantined.length) {
    throw new KbReleaseError("quarantined_document", quarantined.map((d) => d.documentKey).join(","));
  }
  return docs;
}

/**
 * Propose a release for always_human approval. Never publishes.
 * Unchanged documents of the current published release are carried forward so
 * publishing the release (which supersedes the old one) does not drop them.
 */
export async function proposeRelease(
  input: {
    releaseKey: string;
    revisionIds: string[];
    proposedBy: string;
    removeDocumentKeys?: string[];
  },
  store: KbReleaseStore | null = createSupabaseKbReleaseStore()
): Promise<{
  releaseId: string;
  status: "pending_approval";
  revisionIds: string[];
  carriedForward: string[];
  removed: string[];
  supersedes: string | null;
}> {
  if (!store) throw new KbReleaseError("store_unavailable");
  if (!input.releaseKey || !input.revisionIds?.length || !input.proposedBy) {
    throw new KbReleaseError("missing_required_fields");
  }
  const requested = await loadRevisions(store, input.revisionIds);
  const latest = await store.getLatestPublishedRelease(DEFAULT_TENANT_ID);
  let latestRevs: Array<KbRevisionRef & { documentKey: string }> = [];
  if (latest?.revisionIds.length) {
    const revs = await store.getRevisions(latest.revisionIds);
    const docs = await store.getDocuments([...new Set(revs.map((r) => r.documentId))]);
    const keyById = new Map(docs.map((d) => [d.id, d.documentKey]));
    latestRevs = revs.map((r) => ({ ...r, documentKey: keyById.get(r.documentId) ?? "" }));
  }
  const set = buildReleaseRevisionSet({
    requested,
    latestPublished: latestRevs,
    removeDocumentKeys: input.removeDocumentKeys,
  });
  const allRevs = await loadRevisions(store, set.revisionIds);
  await assertNotQuarantined(store, allRevs.map((r) => r.documentId));
  const releaseId = await store.insertPendingRelease({
    tenantId: DEFAULT_TENANT_ID,
    releaseKey: input.releaseKey,
    revisionIds: set.revisionIds,
    supersedes: latest?.id ?? null,
  });
  return {
    releaseId,
    status: "pending_approval",
    revisionIds: set.revisionIds,
    carriedForward: set.carriedForward,
    removed: set.removed,
    supersedes: latest?.id ?? null,
  };
}

/**
 * Publish an approved release. Call only after the always_human approval of
 * kb.release.propose (operator step: scripts/lp-kb-publish.ts).
 *
 * Order is chosen so a partial failure never exposes unapproved content:
 * documents become public first (invisible: search reads only the latest
 * published release), then the release is published, then older published
 * releases are superseded.
 */
export async function publishRelease(
  input: { releaseId: string; publishedBy: string; now?: string },
  store: KbReleaseStore | null = createSupabaseKbReleaseStore()
): Promise<{
  releaseId: string;
  releaseKey: string;
  documentCount: number;
  madePublic: string[];
  superseded: string[];
}> {
  if (!store) throw new KbReleaseError("store_unavailable");
  if (!input.releaseId || !input.publishedBy) throw new KbReleaseError("missing_required_fields");
  const release = await store.getRelease(input.releaseId);
  if (!release) throw new KbReleaseError("release_not_found", input.releaseId);
  if (release.status !== "pending_approval") throw new KbReleaseError("release_not_pending", release.status);
  const latest = await store.getLatestPublishedRelease(release.tenantId);
  if ((latest?.id ?? null) !== (release.supersedes ?? null)) {
    // Another release was published after this one was proposed; its carry-forward
    // set is stale. Propose again.
    throw new KbReleaseError("stale_release", latest?.id ?? "none");
  }
  const revisions = await loadRevisions(store, release.revisionIds);
  const docIds = revisions.map((r) => r.documentId);
  if (new Set(docIds).size !== docIds.length) throw new KbReleaseError("duplicate_document");
  await assertNotQuarantined(store, docIds);

  const at = input.now ?? new Date().toISOString();
  const madePublic = await store.markDocumentsPublic(docIds);
  const ok = await store.markReleasePublished(release.id, input.publishedBy, at);
  if (!ok) throw new KbReleaseError("publish_conflict", release.id);
  const superseded = await store.supersedeOtherPublished(release.tenantId, release.id);
  return {
    releaseId: release.id,
    releaseKey: release.releaseKey,
    documentCount: docIds.length,
    madePublic,
    superseded,
  };
}

function toReleaseRow(row: Record<string, unknown>): KbReleaseRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    releaseKey: String(row.release_key),
    status: String(row.status) as KbReleaseRow["status"],
    revisionIds: Array.isArray(row.revision_ids) ? row.revision_ids.map(String) : [],
    supersedes: row.supersedes ? String(row.supersedes) : null,
  };
}

const RELEASE_COLUMNS = "id, tenant_id, release_key, status, revision_ids, supersedes";

/** Supabase-backed store (service role). Null when Supabase is not configured. */
export function createSupabaseKbReleaseStore(): KbReleaseStore | null {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const fail = (what: string, error: { message?: string } | null) => {
    if (error) throw new Error(`[kb] ${what}: ${error.message || "failed"}`);
  };
  return {
    async getLatestPublishedRelease(tenantId) {
      const { data, error } = await admin
        .from("lp_kb_releases")
        .select(RELEASE_COLUMNS)
        .eq("tenant_id", tenantId)
        .eq("status", "published")
        .order("effective_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      fail("latest release", error);
      return data ? toReleaseRow(data as Record<string, unknown>) : null;
    },
    async getRelease(releaseId) {
      const { data, error } = await admin
        .from("lp_kb_releases")
        .select(RELEASE_COLUMNS)
        .eq("id", releaseId)
        .maybeSingle();
      fail("get release", error);
      return data ? toReleaseRow(data as Record<string, unknown>) : null;
    },
    async getRevisions(revisionIds) {
      if (!revisionIds.length) return [];
      const { data, error } = await admin
        .from("lp_kb_revisions")
        .select("id, document_id, revision")
        .in("id", revisionIds);
      fail("get revisions", error);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        documentId: String(r.document_id),
        revision: Number(r.revision),
      }));
    },
    async getDocuments(documentIds) {
      if (!documentIds.length) return [];
      const { data, error } = await admin
        .from("lp_kb_documents")
        .select("id, document_key, scope")
        .in("id", documentIds);
      fail("get documents", error);
      return ((data ?? []) as Record<string, unknown>[]).map((d) => ({
        id: String(d.id),
        documentKey: String(d.document_key),
        scope: String(d.scope) as KbDocumentRef["scope"],
      }));
    },
    async insertPendingRelease(input) {
      const { data, error } = await admin
        .from("lp_kb_releases")
        .insert({
          tenant_id: input.tenantId,
          release_key: input.releaseKey,
          revision_ids: input.revisionIds,
          supersedes: input.supersedes,
          status: "pending_approval",
        })
        .select("id")
        .single();
      fail("insert release", error);
      if (!data) throw new Error("[kb] insert release: no row");
      return String((data as Record<string, unknown>).id);
    },
    async markDocumentsPublic(documentIds) {
      if (!documentIds.length) return [];
      const { data, error } = await admin
        .from("lp_kb_documents")
        .update({ scope: "public", updated_at: new Date().toISOString() })
        .in("id", documentIds)
        .eq("scope", "internal")
        .select("id");
      fail("publish documents", error);
      return ((data ?? []) as Record<string, unknown>[]).map((d) => String(d.id));
    },
    async markReleasePublished(releaseId, publishedBy, at) {
      const { data, error } = await admin
        .from("lp_kb_releases")
        .update({ status: "published", published_by: publishedBy, published_at: at, effective_at: at })
        .eq("id", releaseId)
        .eq("status", "pending_approval")
        .select("id");
      fail("publish release", error);
      return Array.isArray(data) && data.length === 1;
    },
    async supersedeOtherPublished(tenantId, keepReleaseId) {
      const { data, error } = await admin
        .from("lp_kb_releases")
        .update({ status: "superseded" })
        .eq("tenant_id", tenantId)
        .eq("status", "published")
        .neq("id", keepReleaseId)
        .select("id");
      fail("supersede releases", error);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => String(r.id));
    },
  };
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
