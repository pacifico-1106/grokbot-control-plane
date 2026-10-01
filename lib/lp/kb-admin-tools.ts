/**
 * KB Admin MCP tool handlers.
 * kb.read is read-only (no approval).
 * kb.draft creates a revision (no approval, but content goes to internal scope).
 * kb.release.propose requires always_human approval to publish.
 */

import { isLpChatEnabled } from "@/lib/feature-flags";
import {
  searchKnowledgeBase,
  getPublishedRelease,
  createDraftRevision,
  proposeRelease,
} from "./knowledge-base";

export interface KbReadResult {
  ok: boolean;
  releaseId?: string;
  releaseKey?: string;
  publishedAt?: string | null;
  documentCount?: number;
  passages?: Array<{
    documentKey: string;
    title: string;
    sourceUrl: string | null;
    content: string;
    citation: string;
  }>;
  error?: string;
}

export interface KbDraftResult {
  ok: boolean;
  documentId?: string;
  revision?: number;
  error?: string;
}

export interface KbReleaseProposeResult {
  ok: boolean;
  releaseId?: string;
  status?: "pending_approval";
  error?: string;
}

export async function handleKbRead(input: {
  query?: string;
  limit?: number;
}): Promise<KbReadResult> {
  if (!isLpChatEnabled()) {
    return { ok: false, error: "feature_disabled" };
  }

  const release = await getPublishedRelease();
  if (!release) {
    return { ok: false, error: "no_published_release" };
  }

  if (!input.query) {
    return {
      ok: true,
      releaseId: release.releaseId,
      releaseKey: release.releaseKey,
      publishedAt: release.publishedAt,
      documentCount: release.documentCount,
      passages: [],
    };
  }

  const result = await searchKnowledgeBase(input.query, input.limit || 3);

  if (result.status === "error") {
    return { ok: false, error: "search_failed" };
  }

  const passages = result.passages.map((p) => ({
    documentKey: p.documentKey,
    title: p.title,
    sourceUrl: p.sourceUrl,
    content: p.content,
    citation: `[${p.title}](${p.sourceUrl || "#"}) rev.${p.revision}`,
  }));

  return {
    ok: true,
    releaseId: result.releaseId,
    releaseKey: result.releaseKey,
    passages,
  };
}

export async function handleKbDraft(input: {
  documentKey: string;
  title: string;
  content: string;
  sourceUrl?: string;
}): Promise<KbDraftResult> {
  if (!isLpChatEnabled()) {
    return { ok: false, error: "feature_disabled" };
  }

  if (!input.documentKey || !input.title || !input.content) {
    return { ok: false, error: "missing_required_fields" };
  }

  if (input.content.length > 10000) {
    return { ok: false, error: "content_too_long" };
  }

  try {
    const result = await createDraftRevision({
      documentKey: input.documentKey,
      title: input.title,
      content: input.content,
      sourceUrl: input.sourceUrl,
    });

    if (!result) {
      return { ok: false, error: "draft_creation_failed" };
    }

    return {
      ok: true,
      documentId: result.documentId,
      revision: result.revision,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

export async function handleKbReleasePropose(input: {
  releaseKey: string;
  revisionIds: string[];
  proposedBy: string;
}): Promise<KbReleaseProposeResult> {
  if (!isLpChatEnabled()) {
    return { ok: false, error: "feature_disabled" };
  }

  if (!input.releaseKey || !input.revisionIds?.length || !input.proposedBy) {
    return { ok: false, error: "missing_required_fields" };
  }

  try {
    const result = await proposeRelease({
      releaseKey: input.releaseKey,
      revisionIds: input.revisionIds,
      proposedBy: input.proposedBy,
    });

    if (!result) {
      return { ok: false, error: "propose_failed" };
    }

    return {
      ok: true,
      releaseId: result.releaseId,
      status: result.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

export const KB_ADMIN_TOOL_DEFS = [
  {
    name: "kb.read",
    description:
      "Read the current published KB release with optional search. Returns citations for AI responses. Read-only, no approval required.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (max 500 chars). Omit for release info only.",
        },
        limit: {
          type: "number",
          description: "Max passages to return (default 3, max 10).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kb.draft",
    description:
      "Create a draft KB revision. Content goes to internal scope until published. No approval required for draft creation, but content is not visible in chat until released.",
    inputSchema: {
      type: "object",
      properties: {
        documentKey: {
          type: "string",
          description: "Unique document key (e.g. 'faq-pricing').",
        },
        title: {
          type: "string",
          description: "Document title for display.",
        },
        content: {
          type: "string",
          description: "Document content (max 10000 chars).",
        },
        sourceUrl: {
          type: "string",
          description: "Optional source URL for citation.",
        },
      },
      required: ["documentKey", "title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "kb.release.propose",
    description:
      "Propose a KB release for human approval (always_human). The release bundles specific revisions. Once approved and published, content becomes visible in chat search. Never auto-publish.",
    inputSchema: {
      type: "object",
      properties: {
        releaseKey: {
          type: "string",
          description: "Unique release identifier (e.g. '2026-10-01-v2').",
        },
        revisionIds: {
          type: "array",
          items: { type: "string" },
          description: "UUIDs of revisions to include in this release.",
        },
        proposedBy: {
          type: "string",
          description: "ID of the admin proposing this release.",
        },
      },
      required: ["releaseKey", "revisionIds", "proposedBy"],
      additionalProperties: false,
    },
  },
] as const;

export type KbAdminToolName = (typeof KB_ADMIN_TOOL_DEFS)[number]["name"];
