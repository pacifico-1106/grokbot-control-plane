/**
 * LP AI相談 KB: publish an approved release (operator step after the
 * always_human approval of kb.release.propose). Not an agent tool.
 *
 * Dry run by default: prints the pending release, the documents that would
 * become public and the release that would be superseded. Writes only with
 * --apply.
 *
 * Usage (service-role env must be provided explicitly; never printed):
 *   bun --no-env-file scripts/lp-kb-publish.ts --release-id <uuid> --published-by <approver>
 *   bun --no-env-file scripts/lp-kb-publish.ts --release-id <uuid> --published-by <approver> --apply
 */
import {
  createSupabaseKbReleaseStore,
  publishRelease,
  KbReleaseError,
} from "@/lib/lp/knowledge-base";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const releaseId = arg("--release-id");
  const publishedBy = arg("--published-by");
  const apply = process.argv.includes("--apply");
  if (!releaseId || !publishedBy) {
    console.error("usage: --release-id <uuid> --published-by <approver> [--apply]");
    return 2;
  }
  const store = createSupabaseKbReleaseStore();
  if (!store) {
    console.error("Supabase is not configured (demo mode).");
    return 2;
  }
  const release = await store.getRelease(releaseId);
  if (!release) {
    console.error(`release not found: ${releaseId}`);
    return 1;
  }
  const latest = await store.getLatestPublishedRelease(release.tenantId);
  const revisions = await store.getRevisions(release.revisionIds);
  const docs = await store.getDocuments([...new Set(revisions.map((r) => r.documentId))]);
  console.log(JSON.stringify({
    release: { id: release.id, key: release.releaseKey, status: release.status, supersedes: release.supersedes },
    currentPublished: latest ? { id: latest.id, key: latest.releaseKey } : null,
    documents: docs.map((d) => ({ key: d.documentKey, scope: d.scope })),
    revisionCount: release.revisionIds.length,
  }, null, 2));
  if (!apply) {
    console.log("dry run: re-run with --apply to publish.");
    return 0;
  }
  try {
    const result = await publishRelease({ releaseId, publishedBy }, store);
    console.log(JSON.stringify({ published: result }, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof KbReleaseError ? error.code : String(error));
    return 1;
  }
}

main().then((code) => { process.exitCode = code; });
