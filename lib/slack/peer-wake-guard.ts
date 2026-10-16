/**
 * Shared AI→AI wake filter for Slack mention ingress (channel, DM, Path C).
 *
 * Flags default OFF: this module is a no-op (no lookup, no write).
 * When ON: speaker-bound AI employees may wake another AI only if the org
 * allowlisted the pair (fail-closed) and the thread is under the cap / not
 * human-stopped. Human mentions are never filtered.
 */
import {
  aiPeerWakeCap,
  aiPeerWakeRootWindowSeconds,
  isAiPeerWakeAllowlistEnabled,
  isAiPeerWakeThreadGuardEnabled,
} from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  claimPeerWake,
  isPairAllowed,
  lookupSpeakerBindings,
  type ClaimPeerWakeResult,
} from "@/lib/data/ai-peer-wake";
import type { SlackMentionTarget } from "@/lib/data/slack-identities";

export type PeerWakeDenyReason =
  | "speaker_unavailable"
  | "speaker_ambiguous"
  | "allowlist_denied"
  | "allowlist_unavailable"
  | "cross_org"
  | "thread_stopped"
  | "thread_capped"
  | "thread_unavailable";

export type PeerWakeSkip = {
  target: SlackMentionTarget;
  reason: PeerWakeDenyReason;
};

export type PeerWakeGuardResult = {
  allowed: SlackMentionTarget[];
  skipped: PeerWakeSkip[];
  skipReason?: PeerWakeDenyReason;
};

const NOOP: PeerWakeGuardResult = { allowed: [], skipped: [] };

function emptyWith(targets: SlackMentionTarget[]): PeerWakeGuardResult {
  return { allowed: targets, skipped: [] };
}

async function auditSkip(input: {
  orgId: string;
  employeeId: string | null;
  reason: PeerWakeDenyReason;
  channelId: string;
  threadTs: string | null;
  eventId: string;
  speakerEmployeeId?: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: null,
    action: "slack.peer_wake.denied",
    purpose: "slack.peer_wake",
    summary: `AI同士の起動を見送り: ${input.reason}`,
    metadata: {
      reason: input.reason,
      channel: input.channelId,
      thread_ts: input.threadTs,
      eventId: input.eventId,
      speakerEmployeeId: input.speakerEmployeeId ?? null,
      ...input.extra,
    },
  }).catch(() => undefined);
}

export async function applyPeerWakeGuard(input: {
  speakerId: string;
  teamId: string;
  channelId: string;
  threadTs: string | null;
  eventTs: string;
  eventId: string;
  targets: SlackMentionTarget[];
}): Promise<PeerWakeGuardResult> {
  const allowlistOn = isAiPeerWakeAllowlistEnabled();
  const threadOn = isAiPeerWakeThreadGuardEnabled();
  if (!allowlistOn && !threadOn) return emptyWith(input.targets);
  if (!input.targets.length) return NOOP;

  const speaker = await lookupSpeakerBindings({
    slackUserId: input.speakerId,
    teamId: input.teamId,
  });
  if (speaker.state === "unavailable") {
    const skipped = input.targets.map((target) => ({ target, reason: "speaker_unavailable" as const }));
    for (const item of skipped) {
      await auditSkip({
        orgId: item.target.orgId,
        employeeId: item.target.employeeId,
        reason: "speaker_unavailable",
        channelId: input.channelId,
        threadTs: input.threadTs,
        eventId: input.eventId,
      });
    }
    return { allowed: [], skipped, skipReason: "speaker_unavailable" };
  }
  if (speaker.rows.length === 0) {
    return emptyWith(input.targets);
  }
  if (speaker.rows.length !== 1) {
    const skipped = input.targets.map((target) => ({ target, reason: "speaker_ambiguous" as const }));
    for (const item of skipped) {
      await auditSkip({
        orgId: item.target.orgId,
        employeeId: item.target.employeeId,
        reason: "speaker_ambiguous",
        channelId: input.channelId,
        threadTs: input.threadTs,
        eventId: input.eventId,
      });
    }
    return { allowed: [], skipped, skipReason: "speaker_ambiguous" };
  }

  const from = speaker.rows[0];
  const allowed: SlackMentionTarget[] = [];
  const skipped: PeerWakeSkip[] = [];
  let lastDeny: PeerWakeDenyReason | undefined;
  let notifyClaim: ClaimPeerWakeResult | null = null;
  let notifyTarget: SlackMentionTarget | null = null;

  for (const target of input.targets) {
    if (target.employeeId === from.employeeId) {
      continue;
    }
    if (allowlistOn) {
      if (target.orgId !== from.orgId) {
        skipped.push({ target, reason: "cross_org" });
        lastDeny = "cross_org";
        await auditSkip({
          orgId: from.orgId,
          employeeId: target.employeeId,
          reason: "cross_org",
          channelId: input.channelId,
          threadTs: input.threadTs,
          eventId: input.eventId,
          speakerEmployeeId: from.employeeId,
          extra: { targetOrgId: target.orgId },
        });
        continue;
      }
      const pair = await isPairAllowed({
        orgId: from.orgId,
        fromEmployeeId: from.employeeId,
        toEmployeeId: target.employeeId,
        slackChannelId: input.channelId,
      });
      if (pair.state !== "allowed") {
        const reason = pair.state === "unavailable" ? "allowlist_unavailable" : "allowlist_denied";
        skipped.push({ target, reason });
        lastDeny = reason;
        await auditSkip({
          orgId: from.orgId,
          employeeId: target.employeeId,
          reason,
          channelId: input.channelId,
          threadTs: input.threadTs,
          eventId: input.eventId,
          speakerEmployeeId: from.employeeId,
        });
        continue;
      }
    }
    if (threadOn) {
      const claim = await claimPeerWake({
        orgId: from.orgId,
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        eventTs: input.eventTs,
        cap: aiPeerWakeCap(),
        windowSeconds: aiPeerWakeRootWindowSeconds(),
      });
      if (claim.state === "allowed") {
        allowed.push(target);
        if (claim.notify) {
          notifyClaim = claim;
          notifyTarget = target;
        }
        continue;
      }
      const reason: PeerWakeDenyReason =
        claim.state === "stopped"
          ? "thread_stopped"
          : claim.state === "capped"
            ? "thread_capped"
            : claim.state === "unavailable"
              ? "thread_unavailable"
              : "thread_unavailable";
      skipped.push({ target, reason });
      lastDeny = reason;
      await auditSkip({
        orgId: from.orgId,
        employeeId: target.employeeId,
        reason,
        channelId: input.channelId,
        threadTs: input.threadTs,
        eventId: input.eventId,
        speakerEmployeeId: from.employeeId,
        extra:
          claim.state === "capped" || claim.state === "stopped"
            ? { threadId: claim.threadId, stopRef: claim.stopRef, count: claim.count }
            : {},
      });
      if (claim.state === "capped" && claim.notify) {
        notifyClaim = claim;
        notifyTarget = target;
      }
      continue;
    }
    allowed.push(target);
  }

  if (notifyClaim && (notifyClaim.state === "capped" || notifyClaim.state === "allowed") && notifyTarget) {
    const { notifyPeerWakeCap } = await import("@/lib/notify/ai-peer-wake-notice");
    await notifyPeerWakeCap({
      orgId: from.orgId,
      speakerEmployeeId: from.employeeId,
      targetEmployeeId: notifyTarget.employeeId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      eventId: input.eventId,
      stopRef: notifyClaim.stopRef,
      count: notifyClaim.count,
      cap: aiPeerWakeCap(),
    }).catch(() => undefined);
  }

  return { allowed, skipped, skipReason: allowed.length ? undefined : lastDeny };
}
