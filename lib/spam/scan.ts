/**
 * spam.scan — read-only scoring over recent org signups. Output is masked
 * (no full emails) and safe to return through Admin MCP or store in reports.
 */
import { maskEmail, scoreSpamFacts, type SpamFacts } from "./score";
import { protectedOrgIds } from "./accounts";
import type { SpamStore } from "./store";

export const SPAM_SCAN_DEFAULT_DAYS = 30;
export const SPAM_SCAN_MAX_DAYS = 180;

export type SpamScanEntry = {
  orgId: string;
  orgName: string;
  createdAt: string;
  score: number;
  band: "candidate" | "watch" | "ok";
  signals: string[];
  ownerEmailMasked: string;
  suspended: boolean;
  protected: boolean;
};

export type SpamScanReport = {
  generatedAt: string;
  windowDays: number;
  scanned: number;
  candidateCount: number;
  watchCount: number;
  /** Candidates not yet suspended and not protected — what a proposal would target. */
  proposableOrgIds: string[];
  candidates: SpamScanEntry[];
  watch: SpamScanEntry[];
};

export function clampScanDays(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return SPAM_SCAN_DEFAULT_DAYS;
  return Math.min(n, SPAM_SCAN_MAX_DAYS);
}

function isSuspended(f: SpamFacts, now: Date): boolean {
  const banned = !!f.bannedUntil && Date.parse(f.bannedUntil) > now.getTime();
  return banned && f.ownerMemberStatus === "disabled";
}

export function buildSpamScanReport(
  facts: SpamFacts[],
  windowDays: number,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): SpamScanReport {
  const protectedIds = protectedOrgIds(env);
  const entries: SpamScanEntry[] = facts.map((f) => {
    const s = scoreSpamFacts(f, now);
    const isProtected = protectedIds.has(f.orgId.toLowerCase());
    return {
      orgId: f.orgId,
      orgName: (f.orgName || "").slice(0, 60),
      createdAt: f.orgCreatedAt,
      score: isProtected ? 0 : s.score,
      band: isProtected ? "ok" : s.band,
      signals: s.signals.map((x) => x.code),
      ownerEmailMasked: maskEmail(f.ownerEmail),
      suspended: isSuspended(f, now),
      protected: isProtected,
    };
  });
  const candidates = entries.filter((e) => e.band === "candidate").sort((a, b) => b.score - a.score);
  const watch = entries.filter((e) => e.band === "watch").sort((a, b) => b.score - a.score);
  return {
    generatedAt: now.toISOString(),
    windowDays,
    scanned: entries.length,
    candidateCount: candidates.length,
    watchCount: watch.length,
    proposableOrgIds: candidates.filter((c) => !c.suspended && !c.protected).map((c) => c.orgId).slice(0, 50),
    candidates,
    watch,
  };
}

export async function runSpamScan(store: SpamStore, days: number, now: Date = new Date()): Promise<SpamScanReport> {
  const windowDays = clampScanDays(days);
  const facts = await store.scanFacts(windowDays);
  return buildSpamScanReport(facts, windowDays, now);
}
