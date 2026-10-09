/**
 * Path C (木村 2026-10-09): what happens next when a user-token channel mention
 * is NOT woken because the channel is unclassified (DL-2 fail-closed skip).
 *
 * Reuses #276/#280 unchanged:
 * - CHANNEL_CLASSIFY_PROPOSALS_ENABLED → proposeChannelClassification
 *   (trigger "wake_skipped"): one channels.classify card per channel (proposal
 *   dedupe), always_human, per-org hourly proposal cap, no-approver → ops.
 * - CHANNEL_STUCK_NOTIFY_ENABLED → notifyChannelStuck
 *   (kind "unclassified_channel_wake_skipped"): one notice per org × channel per
 *   6h window (DB), then the per-org hourly notice cap (one summary over it).
 *
 * #292 21:50: a channel whose card a human REJECTED → no notice and no card for
 * 30 days (lib/channel-classify/reject-suppression.ts; counts-only audit;
 * lifted by a new admin channels.classify request for that channel).
 *
 * Input is ids only (org, employee, channel, team); the message text never
 * reaches this module. Bounded (timeout), never throws, and never changes the
 * skip outcome. Both flags OFF → returns immediately (no read, no write).
 */
import { isChannelClassifyProposalsEnabled, isChannelStuckNotifyEnabled } from "@/lib/channel-classify/flags";
import { unverifiedFacts, type ProposalState } from "@/lib/channel-classify/core";
import { factsForSignal } from "@/lib/channel-classify/join";
import { proposeChannelClassification } from "@/lib/channel-classify/proposals";
import { notifyChannelStuck } from "@/lib/channel-classify/stuck-notify";
import { auditWakeSkipSuppressed, wakeSkipSuppressionForRejectedCard } from "@/lib/channel-classify/reject-suppression";

export const WAKE_SKIP_HOOK_TIMEOUT_MS = 6_000;
const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

export type WakeSkipHookInput = {
  orgId: string;
  employeeId: string;
  channelId: string;
  /** The subscriber's (= bound employee's) Slack team: counts as the home team for facts. */
  homeTeamId: string;
};

async function run(input: WakeSkipHookInput): Promise<void> {
  const ref = { surface: "slack" as const, externalId: input.channelId };
  // 21:50: a human rejected this channel's card → no notice and no card for 30
  // days (counts-only audit); lifted by a new admin channels.classify request.
  const suppression = await wakeSkipSuppressionForRejectedCard({ orgId: input.orgId, channelId: input.channelId });
  if (suppression.suppressed) {
    await auditWakeSkipSuppressed({
      orgId: input.orgId,
      channelId: input.channelId,
      rejectedApprovalId: suppression.rejectedApprovalId,
      suppressedUntil: suppression.suppressedUntil,
    });
    return;
  }
  let approvalId: string | undefined;
  let proposalState: ProposalState = "not_proposed";
  if (isChannelClassifyProposalsEnabled()) {
    const facts = await factsForSignal({
      orgId: input.orgId,
      ...ref,
      trigger: "wake_skipped",
      homeTeamId: input.homeTeamId || undefined,
    }).catch(() => unverifiedFacts(ref));
    const outcome = await proposeChannelClassification({ orgId: input.orgId, facts, trigger: "wake_skipped" });
    approvalId = outcome.approvalId;
    proposalState =
      outcome.state === "created" || outcome.state === "pending" || outcome.state === "decided"
        ? outcome.state
        : outcome.state === "error"
          ? "error"
          : "not_proposed";
  }
  if (!isChannelStuckNotifyEnabled()) return;
  let approvalChannelId: string | null = null;
  try {
    const { getEmployee } = await import("@/lib/data/employees");
    const employee = await getEmployee(input.employeeId, input.orgId);
    approvalChannelId = employee && employee.orgId === input.orgId ? employee.approvalChannelId ?? null : null;
  } catch {
    approvalChannelId = null;
  }
  await notifyChannelStuck({
    orgId: input.orgId,
    kind: "unclassified_channel_wake_skipped",
    ref,
    reason: "channel_not_classified",
    approvalId,
    proposalState,
    employee: { approvalChannelId },
  });
}

export async function onUnclassifiedWakeSkipped(input: WakeSkipHookInput): Promise<void> {
  if (!isChannelClassifyProposalsEnabled() && !isChannelStuckNotifyEnabled()) return;
  if (!input.orgId || !input.employeeId || !CHANNEL_RE.test(input.channelId || "")) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(input).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WAKE_SKIP_HOOK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // never throws: the skip outcome is unchanged
  } finally {
    if (timer) clearTimeout(timer);
  }
}
