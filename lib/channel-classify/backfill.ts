/**
 * PR-B backfill: propose classifications for channels the org's own Slack bot
 * has already joined (users.conversations). Same proposal path as join events
 * (dedupe, always_human, never applied). IMs are never proposed. A failure is
 * reported (backfill_failed notice), never swallowed.
 *
 * Follow-up N4 (Slack rate limits):
 * - every Slack call goes through a pacer: per-method minimum spacing
 *   (SLACK_MIN_INTERVAL_MS), users.info strictly sequential;
 * - a gap between channels and fewer members inspected per channel;
 * - a Slack `ratelimited` answer stops the run (stoppedReason rate_limited,
 *   Retry-After kept) — not a failure notice, the next run continues;
 * - a per-run deadline (the cron passes one for all orgs) stops before the
 *   next channel (stoppedReason time_budget).
 */
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import {
  collectSlackChannelFacts,
  createSlackPacer,
  listSlackBotChannels,
  SlackRateLimitedError,
} from "@/lib/channel-classify/facts";
import { unverifiedFacts } from "@/lib/channel-classify/core";
import { isChannelRegistered, proposeChannelClassification } from "@/lib/channel-classify/proposals";
import { notifyChannelStuck } from "@/lib/channel-classify/stuck-notify";

export const BACKFILL_MAX_CHANNELS = 200;
export const BACKFILL_MAX_NEW_PROPOSALS = 20;
/** Slack fact collections per org per run (each is several Slack API calls). */
export const BACKFILL_MAX_INSPECTED = 30;
/** Members whose profile is looked up per channel in backfill (join events use the full limit). */
export const BACKFILL_MAX_MEMBERS_INSPECTED = 20;
export const BACKFILL_CHANNEL_GAP_MS = 1_000;
/** Default per-org run budget when the caller passes no deadline. */
export const BACKFILL_TIME_BUDGET_MS = 240_000;

export type BackfillResult = {
  ok: boolean;
  skipped?: "flag_off";
  scanned: number;
  created: number;
  approvalIds: string[];
  errors: number;
  reason?: string;
  stoppedReason?: "rate_limited" | "time_budget";
  retryAfterSeconds?: number;
};

type Deps = { now: () => number; sleep: (ms: number) => Promise<void> };
const DEFAULT_DEPS: Deps = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
let deps: Deps = DEFAULT_DEPS;

export function setBackfillDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

export function backfillNow(): number {
  return deps.now();
}

export async function backfillOrgChannelProposals(orgId: string, opts: { deadlineMs?: number } = {}): Promise<BackfillResult> {
  const result: BackfillResult = { ok: true, scanned: 0, created: 0, approvalIds: [], errors: 0 };
  if (!isChannelClassifyProposalsEnabled()) return { ...result, skipped: "flag_off" };
  const deadline = opts.deadlineMs ?? deps.now() + BACKFILL_TIME_BUDGET_MS;
  const pacer = createSlackPacer({ now: deps.now, sleep: deps.sleep });
  const stopForRateLimit = (): BackfillResult => ({
    ...result,
    stoppedReason: "rate_limited",
    retryAfterSeconds: pacer.rateLimited?.retryAfterSeconds,
  });

  let channels: Array<{ id: string; isIm: boolean }>;
  try {
    channels = await listSlackBotChannels(orgId, BACKFILL_MAX_CHANNELS, { pacer });
  } catch (error) {
    if (error instanceof SlackRateLimitedError || pacer.rateLimited) return stopForRateLimit();
    const reason = error instanceof Error ? error.message : "slack_list_failed";
    await notifyChannelStuck({ orgId, kind: "backfill_failed", reason, dedupeKey: "slack" });
    return { ...result, ok: false, reason: "slack_list_failed" };
  }
  result.scanned = channels.length;
  let inspected = 0;
  for (const channel of channels) {
    if (channel.isIm || channel.id.startsWith("D")) continue;
    if (result.created >= BACKFILL_MAX_NEW_PROPOSALS || inspected >= BACKFILL_MAX_INSPECTED) break; // the next run continues
    const ref = { surface: "slack" as const, externalId: channel.id };
    if (await isChannelRegistered(orgId, ref).catch(() => false)) continue;
    if (deps.now() >= deadline) return { ...result, stoppedReason: "time_budget" };
    if (inspected > 0) await deps.sleep(BACKFILL_CHANNEL_GAP_MS);
    inspected += 1;
    const facts = await collectSlackChannelFacts(orgId, channel.id, { pacer, maxMembersInspected: BACKFILL_MAX_MEMBERS_INSPECTED }).catch(() => null);
    if (pacer.rateLimited) return stopForRateLimit(); // partial facts are never proposed
    const outcome = await proposeChannelClassification({ orgId, facts: facts ?? unverifiedFacts(ref), trigger: "backfill" });
    if (outcome.state === "created" && outcome.approvalId) {
      result.created += 1;
      result.approvalIds.push(outcome.approvalId);
    } else if (outcome.state === "error") {
      result.errors += 1;
    } else if (outcome.state === "rate_limited" || outcome.state === "no_approver") {
      break; // org-level stop (H1 cap / N3): nothing more this run
    }
  }
  if (result.errors > 0) {
    await notifyChannelStuck({ orgId, kind: "backfill_failed", reason: `proposal_errors_${result.errors}`, dedupeKey: "slack" });
    return { ...result, ok: false, reason: "proposal_errors" };
  }
  return result;
}
