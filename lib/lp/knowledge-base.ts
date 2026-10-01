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

    const { data, error } = await admin.rpc("search_published_kb", {
      p_query: query,
      p_tenant_id: DEFAULT_TENANT_ID,
      p_limit: limit,
    });

    if (error) {
      console.error("[kb] Search failed:", error);
      return { releaseId, releaseKey, status: "error", passages: [] };
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      return { releaseId, releaseKey, status: "not_found", passages: [] };
    }

    const passages: KbDocument[] = data.map((row: Record<string, unknown>) => ({
      documentId: String(row.document_id),
      documentKey: String(row.document_key),
      title: String(row.title),
      sourceUrl: row.source_url ? String(row.source_url) : null,
      revision: Number(row.revision),
      content: String(row.content),
      releaseKey: String(row.release_key),
    }));

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

export async function proposeRelease(input: {
  releaseKey: string;
  revisionIds: string[];
  proposedBy: string;
}): Promise<{ releaseId: string; status: "pending_approval" } | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  try {
    const { data, error } = await admin
      .from("lp_kb_releases")
      .insert({
        tenant_id: DEFAULT_TENANT_ID,
        release_key: input.releaseKey,
        revision_ids: input.revisionIds,
        status: "pending_approval",
      })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(error?.message || "release_propose_failed");
    }

    return { releaseId: String(data.id), status: "pending_approval" };
  } catch (error) {
    console.error("[kb] Propose release failed:", error);
    throw error;
  }
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
