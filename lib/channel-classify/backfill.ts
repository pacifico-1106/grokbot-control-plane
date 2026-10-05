/**
 * PR-B backfill: propose classifications for channels the org's own Slack bot
 * has already joined (users.conversations). Same proposal path as join events
 * (dedupe, always_human, never applied). IMs are never proposed. A failure is
 * reported (backfill_failed notice), never swallowed.
 */
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { collectSlackChannelFacts, listSlackBotChannels } from "@/lib/channel-classify/facts";
import { unverifiedFacts } from "@/lib/channel-classify/core";
import { isChannelRegistered, proposeChannelClassification } from "@/lib/channel-classify/proposals";
import { notifyChannelStuck } from "@/lib/channel-classify/stuck-notify";

export const BACKFILL_MAX_CHANNELS = 200;
export const BACKFILL_MAX_NEW_PROPOSALS = 20;
/** Slack fact collections per org per run (each is several Slack API calls). */
export const BACKFILL_MAX_INSPECTED = 30;

export type BackfillResult = {
  ok: boolean;
  skipped?: "flag_off";
  scanned: number;
  created: number;
  approvalIds: string[];
  errors: number;
  reason?: string;
};

export async function backfillOrgChannelProposals(orgId: string): Promise<BackfillResult> {
  const result: BackfillResult = { ok: true, scanned: 0, created: 0, approvalIds: [], errors: 0 };
  if (!isChannelClassifyProposalsEnabled()) return { ...result, skipped: "flag_off" };
  let channels: Array<{ id: string; isIm: boolean }>;
  try {
    channels = await listSlackBotChannels(orgId, BACKFILL_MAX_CHANNELS);
  } catch (error) {
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
    inspected += 1;
    const facts = (await collectSlackChannelFacts(orgId, channel.id).catch(() => null)) ?? unverifiedFacts(ref);
    const outcome = await proposeChannelClassification({ orgId, facts, trigger: "backfill" });
    if (outcome.state === "created" && outcome.approvalId) {
      result.created += 1;
      result.approvalIds.push(outcome.approvalId);
    } else if (outcome.state === "error") {
      result.errors += 1;
    }
  }
  if (result.errors > 0) {
    await notifyChannelStuck({ orgId, kind: "backfill_failed", reason: `proposal_errors_${result.errors}`, dedupeKey: "slack" });
    return { ...result, ok: false, reason: "proposal_errors" };
  }
  return result;
}
// TDD stub (replaced in the implementation commit).
export function setBackfillDepsForTests(_override: unknown): void {}
