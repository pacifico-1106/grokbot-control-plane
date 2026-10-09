/**
 * Path C one-time re-wake (PATHC_REWAKE_ON_CLASSIFY_ENABLED, default OFF).
 *
 * When a human-approved channels.classify (admin ticket or config-change
 * proposal) is applied, the latest user-token channel mention per employee that
 * was skipped as unclassified in that channel (lib/data/slack-skipped-wakes) is
 * re-woken EXACTLY ONCE:
 * - org = the approval's org; the stored ticket is re-read and must be
 *   approved and of that org (BOLA / no self-approval shortcut);
 * - the classification now in the org's ledger must allow a Path C wake
 *   (anything but "unknown", the same rule as the live wake path); otherwise
 *   nothing is claimed and the record waits for a real classification;
 * - one atomic DB claim per row (concurrent approvals → one winner);
 * - binding / team re-checked at re-wake time; the wake carries ids and the
 *   Slack ts only — text is empty (the record never held it) and bodyMode is
 *   "none"; the employee reads the message through its normal, gated tools.
 * Records older than 24h are not re-woken. Never throws.
 */
import type { ApprovalRequest } from "@/lib/types";
import { claimSkippedChannelWakes, SKIPPED_WAKE_TTL_SECONDS } from "@/lib/data/slack-skipped-wakes";

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

/** PATHC_REWAKE_ON_CLASSIFY_ENABLED: record unclassified Path C skips and re-wake once on approval. Default OFF. */
export function isPathCRewakeOnClassifyEnabled(): boolean {
  return parseFlag(process.env.PATHC_REWAKE_ON_CLASSIFY_ENABLED);
}

/** The live Path C rule (lib/slack/mention-ingress.ts): only "unknown" blocks a wake. */
export function classificationAllowsUserChannelWake(classification: string | null | undefined): boolean {
  return typeof classification === "string" && classification !== "" && classification !== "unknown";
}

export type RewakeResult = {
  state: "flag_off" | "not_applicable" | "not_approved" | "class_disallows" | "claim_denied" | "unavailable" | "done" | "error";
  woke: number;
};

const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

export async function rewakeSkippedChannelWakesAfterApproval(input: {
  approval: ApprovalRequest;
  surface: string;
  externalId: string;
}): Promise<RewakeResult> {
  if (!isPathCRewakeOnClassifyEnabled()) return { state: "flag_off", woke: 0 };
  try {
    const orgId = (input.approval?.orgId || "").trim();
    const channelId = (input.externalId || "").trim();
    if (!orgId || input.surface !== "slack" || !CHANNEL_RE.test(channelId)) return { state: "not_applicable", woke: 0 };
    if (input.approval.status !== "approved") return { state: "not_approved", woke: 0 };
    const { getApprovalById } = await import("@/lib/data/approvals");
    const stored = await getApprovalById(input.approval.id, orgId).catch(() => null);
    if (!stored || stored.orgId !== orgId || stored.status !== "approved") return { state: "not_approved", woke: 0 };

    const { getOrgChannel } = await import("@/lib/data/directory");
    const channel = await getOrgChannel(orgId, "slack", channelId).catch(() => null);
    if (!channel || channel.orgId !== orgId || !classificationAllowsUserChannelWake(channel.classification)) {
      return { state: "class_disallows", woke: 0 };
    }

    const claim = await claimSkippedChannelWakes({ orgId, channelId, approvalId: stored.id, ttlSeconds: SKIPPED_WAKE_TTL_SECONDS });
    if (claim.state === "denied") return { state: "claim_denied", woke: 0 };
    if (claim.state !== "ok") return { state: "unavailable", woke: 0 };
    if (!claim.rows.length) return { state: "done", woke: 0 };

    const { rewakeUserTokenChannelMention } = await import("@/lib/slack/mention-ingress");
    let woke = 0;
    for (const row of claim.rows) {
      const ok = await rewakeUserTokenChannelMention({
        orgId,
        row,
        classification: channel.classification,
        approvalId: stored.id,
      }).catch(() => false);
      if (ok) woke += 1;
    }
    return { state: "done", woke };
  } catch {
    return { state: "error", woke: 0 };
  }
}

// fail-first compile stub (replaced in the next commit)
export function buildPathCRewakeInstructionJa(_input: { channelId: string; ts: string; threadTs?: string | null }): string {
  return "";
}
