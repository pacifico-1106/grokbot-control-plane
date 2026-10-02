import { describe, expect, mock, test } from "bun:test";

let rpcResults: Record<string, unknown[]> = {};
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: rpcResults[name] ?? [], error: null };
    },
  }),
}));

const {
  buildReleaseRevisionSet,
  proposeRelease,
  publishRelease,
  searchKnowledgeBase,
  selectLatestReleasePassages,
  KbReleaseError,
} = await import("./knowledge-base");
type Store = import("./knowledge-base").KbReleaseStore;
type Row = import("./knowledge-base").KbReleaseRow;
type Doc = import("./knowledge-base").KbDocumentRef;
type Rev = import("./knowledge-base").KbRevisionRef;

const T = "00000000-0000-0000-0000-000000000001";

function memoryStore(init: { docs: Doc[]; revs: Rev[]; releases: Array<Row & { effectiveAt: string }> }) {
  const docs = new Map(init.docs.map((d) => [d.id, { ...d }]));
  const revs = new Map(init.revs.map((r) => [r.id, { ...r }]));
  const releases = new Map(init.releases.map((r) => [r.id, { ...r }]));
  const log: string[] = [];
  let seq = 0;
  const store: Store = {
    async getLatestPublishedRelease(tenantId) {
      const pub = [...releases.values()]
        .filter((r) => r.tenantId === tenantId && r.status === "published")
        .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
      return pub[0] ?? null;
    },
    async getRelease(id) {
      return releases.get(id) ?? null;
    },
    async getRevisions(ids) {
      return ids.flatMap((id) => (revs.has(id) ? [revs.get(id)!] : []));
    },
    async getDocuments(ids) {
      return ids.flatMap((id) => (docs.has(id) ? [docs.get(id)!] : []));
    },
    async insertPendingRelease(input) {
      const id = `rel-new-${++seq}`;
      releases.set(id, { id, ...input, status: "pending_approval", effectiveAt: "2026-10-02T00:00:00Z" });
      log.push(`insert:${id}`);
      return id;
    },
    async markDocumentsPublic(ids) {
      const changed = ids.filter((id) => docs.get(id)?.scope === "internal");
      for (const id of changed) docs.get(id)!.scope = "public";
      log.push(`public:${changed.join(",")}`);
      return changed;
    },
    async markReleasePublished(id, _by, at) {
      const r = releases.get(id);
      if (!r || r.status !== "pending_approval") return false;
      r.status = "published";
      r.effectiveAt = at;
      log.push(`published:${id}`);
      return true;
    },
    async supersedeOtherPublished(tenantId, keep) {
      const changed = [...releases.values()].filter((r) => r.tenantId === tenantId && r.status === "published" && r.id !== keep);
      for (const r of changed) r.status = "superseded";
      log.push(`superseded:${changed.map((r) => r.id).join(",")}`);
      return changed.map((r) => r.id);
    },
  };
  return { store, docs, releases, log };
}

/** Seed: faq-sp01..03 public (release rel-seed), faq-sp12 internal draft, policy-trial quarantined. */
function seeded() {
  return memoryStore({
    docs: [
      { id: "d1", documentKey: "faq-sp01", scope: "public" },
      { id: "d2", documentKey: "faq-sp02", scope: "public" },
      { id: "d3", documentKey: "faq-sp03", scope: "public" },
      { id: "d12", documentKey: "faq-sp12", scope: "internal" },
      { id: "dq", documentKey: "policy-trial", scope: "quarantined" },
    ],
    revs: [
      { id: "r1v1", documentId: "d1", revision: 1 },
      { id: "r2v1", documentId: "d2", revision: 1 },
      { id: "r3v1", documentId: "d3", revision: 1 },
      { id: "r2v2", documentId: "d2", revision: 2 },
      { id: "r12v1", documentId: "d12", revision: 1 },
      { id: "rqv1", documentId: "dq", revision: 1 },
    ],
    releases: [
      { id: "rel-seed", tenantId: T, releaseKey: "2026-10-01-initial", status: "published", revisionIds: ["r1v1", "r2v1", "r3v1"], supersedes: null, effectiveAt: "2026-10-01T00:00:00Z" },
    ],
  });
}

describe("buildReleaseRevisionSet", () => {
  test("carries forward unchanged documents and replaces updated ones", () => {
    const set = buildReleaseRevisionSet({
      requested: [{ id: "r2v2", documentId: "d2", revision: 2 }],
      latestPublished: [
        { id: "r1v1", documentId: "d1", revision: 1, documentKey: "faq-sp01" },
        { id: "r2v1", documentId: "d2", revision: 1, documentKey: "faq-sp02" },
        { id: "r3v1", documentId: "d3", revision: 1, documentKey: "faq-sp03" },
      ],
      removeDocumentKeys: ["faq-sp03"],
    });
    expect(set.revisionIds).toEqual(["r2v2", "r1v1"]);
    expect(set.carriedForward).toEqual(["r1v1"]);
    expect(set.removed).toEqual(["r3v1"]);
  });

  test("rejects two revisions of the same document", () => {
    expect(() =>
      buildReleaseRevisionSet({
        requested: [
          { id: "a", documentId: "d2", revision: 1 },
          { id: "b", documentId: "d2", revision: 2 },
        ],
        latestPublished: [],
      })
    ).toThrow(KbReleaseError);
  });
});

describe("proposeRelease", () => {
  test("creates pending_approval with carry-forward and supersedes the current release", async () => {
    const { store, releases } = seeded();
    const res = await proposeRelease(
      { releaseKey: "2026-10-03-v2", revisionIds: ["r2v2", "r12v1"], proposedBy: "admin" },
      store
    );
    expect(res.status).toBe("pending_approval");
    expect(res.supersedes).toBe("rel-seed");
    expect(res.revisionIds.sort()).toEqual(["r12v1", "r1v1", "r2v2", "r3v1"]);
    expect(res.carriedForward.sort()).toEqual(["r1v1", "r3v1"]);
    // proposing never publishes
    expect(releases.get("rel-seed")!.status).toBe("published");
    expect(releases.get(res.releaseId)!.status).toBe("pending_approval");
  });

  test("rejects quarantined documents and unknown revisions", async () => {
    const { store } = seeded();
    await expect(
      proposeRelease({ releaseKey: "x", revisionIds: ["rqv1"], proposedBy: "admin" }, store)
    ).rejects.toThrow("quarantined_document");
    await expect(
      proposeRelease({ releaseKey: "x", revisionIds: ["nope"], proposedBy: "admin" }, store)
    ).rejects.toThrow("unknown_revision");
  });
});

describe("publishRelease", () => {
  test("makes included documents public, publishes, then supersedes the previous release", async () => {
    const { store, docs, releases, log } = seeded();
    const proposed = await proposeRelease(
      { releaseKey: "2026-10-03-v2", revisionIds: ["r2v2", "r12v1"], proposedBy: "admin" },
      store
    );
    const res = await publishRelease(
      { releaseId: proposed.releaseId, publishedBy: "yasaka", now: "2026-10-03T01:00:00Z" },
      store
    );
    expect(res.madePublic).toEqual(["d12"]);
    expect(res.superseded).toEqual(["rel-seed"]);
    expect(res.documentCount).toBe(4);
    expect(docs.get("d12")!.scope).toBe("public");
    expect(docs.get("dq")!.scope).toBe("quarantined");
    expect(releases.get(proposed.releaseId)!.status).toBe("published");
    expect(releases.get("rel-seed")!.status).toBe("superseded");
    expect(log.slice(-3).map((l) => l.split(":")[0])).toEqual(["public", "published", "superseded"]);
    expect((await store.getLatestPublishedRelease(T))!.id).toBe(proposed.releaseId);
  });

  test("refuses a release that is not pending_approval", async () => {
    const { store } = seeded();
    await expect(publishRelease({ releaseId: "rel-seed", publishedBy: "x" }, store)).rejects.toThrow(
      "release_not_pending"
    );
    await expect(publishRelease({ releaseId: "missing", publishedBy: "x" }, store)).rejects.toThrow(
      "release_not_found"
    );
  });

  test("refuses a stale proposal after another release was published", async () => {
    const { store, releases } = seeded();
    const a = await proposeRelease({ releaseKey: "a", revisionIds: ["r2v2"], proposedBy: "admin" }, store);
    const b = await proposeRelease({ releaseKey: "b", revisionIds: ["r12v1"], proposedBy: "admin" }, store);
    await publishRelease({ releaseId: a.releaseId, publishedBy: "x", now: "2026-10-03T01:00:00Z" }, store);
    await expect(publishRelease({ releaseId: b.releaseId, publishedBy: "x" }, store)).rejects.toThrow(
      "stale_release"
    );
    expect(releases.get(b.releaseId)!.status).toBe("pending_approval");
  });

  test("refuses when an included document was quarantined after proposal", async () => {
    const { store, docs, log } = seeded();
    const p = await proposeRelease({ releaseKey: "a", revisionIds: ["r12v1"], proposedBy: "admin" }, store);
    docs.get("d12")!.scope = "quarantined";
    await expect(publishRelease({ releaseId: p.releaseId, publishedBy: "x" }, store)).rejects.toThrow(
      "quarantined_document"
    );
    expect(log.some((l) => l.startsWith("public:"))).toBe(false);
  });
});

describe("knowledge_search restricted to the latest published release", () => {
  const row = (doc: string, rel: string, revision = 1) => ({
    document_id: doc,
    document_key: `key-${doc}`,
    title: `t-${doc}`,
    source_url: null,
    revision,
    content: `c-${doc}-${revision}`,
    release_key: rel,
  });

  test("drops rows of older releases and dedupes carried-forward documents", async () => {
    rpcResults = {
      get_published_kb_release: [{ release_id: "rel-v2", release_key: "v2", published_at: null, document_count: 4 }],
      search_published_kb: [
        row("d1", "initial"),
        row("d1", "v2"),
        row("d2", "initial", 1),
        row("d2", "v2", 2),
        row("d3", "v2"),
        row("d4", "v2"),
      ],
    };
    const res = await searchKnowledgeBase("q", 3);
    expect(res.status).toBe("found");
    expect(res.passages.map((p) => [p.documentId, p.releaseKey, p.revision])).toEqual([
      ["d1", "v2", 1],
      ["d2", "v2", 2],
      ["d3", "v2", 1],
    ]);
    const call = rpcCalls.find((c) => c.name === "search_published_kb")!;
    expect(call.args.p_limit).toBe(12);
  });

  test("only older-release matches → not_found", async () => {
    rpcResults = {
      get_published_kb_release: [{ release_id: "rel-v2", release_key: "v2" }],
      search_published_kb: [row("d9", "initial")],
    };
    const res = await searchKnowledgeBase("q", 3);
    expect(res.status).toBe("not_found");
    expect(res.passages).toEqual([]);
  });

  test("selectLatestReleasePassages keeps RPC order and limit", () => {
    const docs = ["a", "b", "c"].map((d) => ({
      documentId: d, documentKey: d, title: d, sourceUrl: null, revision: 1, content: d, releaseKey: "v2",
    }));
    expect(selectLatestReleasePassages(docs, "v2", 2).map((d) => d.documentId)).toEqual(["a", "b"]);
  });
});
