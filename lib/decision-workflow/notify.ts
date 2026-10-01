/**
 * P1 Decision Workflow — Notification Delivery
 *
 * Send voting cards through existing approval notification adapters.
 * Only active when P1_DECISION_WORKFLOW_ENABLED is ON.
 */

import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";
import {
  appendAuditEvent,
  getEnabledNotificationChannels,
  type NotificationChannelRuntime,
} from "@/lib/data";
import type { ApprovalRequest } from "@/lib/types";
import {
  buildDecisionVotingCard,
  formatDecisionCardForSlack,
  formatDecisionCardForTelegram,
} from "./voting-card";
import { sendTelegramTextToChannel } from "@/lib/notify/telegram";

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;

export interface DecisionNotificationResult {
  ok: boolean;
  provider: "telegram" | "slack" | "line";
  channelId?: string;
  error?: string;
  skipped?: boolean;
}

function hasTelegramCredentials(channel: NotificationChannelRuntime): boolean {
  return Boolean(
    channel.secrets?.botToken &&
      (channel.config?.chatId || channel.config?.channelId)
  );
}

function hasSlackCredentials(channel: NotificationChannelRuntime): boolean {
  return Boolean(channel.secrets?.botToken && channel.config?.channelId);
}

async function postSlackMessage(
  botToken: string,
  channelId: string,
  text: string,
  blocks: unknown[]
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, text, blocks }),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };

  return { ok: body.ok === true, error: body.error };
}

/**
 * Send decision voting card through notification channels.
 * Uses same infrastructure as approval notifications.
 *
 * @returns Empty array if flag is OFF or no decision metadata.
 */
export async function sendDecisionVotingCard(
  approval: ApprovalRequest
): Promise<DecisionNotificationResult[]> {
  if (!isDecisionWorkflowEnabled()) {
    return [];
  }

  const metadata = approval.metadata as Record<string, unknown> | null;
  if (!metadata?.tier || metadata.type !== "decision_request") {
    return [];
  }

  const results: DecisionNotificationResult[] = [];

  try {
    const card = buildDecisionVotingCard(approval, metadata);
    const channels = await getEnabledNotificationChannels(approval.orgId);

    for (const channel of channels) {
      if (channel.provider === "telegram" && hasTelegramCredentials(channel)) {
        const telegramCard = formatDecisionCardForTelegram(card);
        try {
          await sendTelegramTextToChannel(channel, telegramCard.text);
          results.push({ ok: true, provider: "telegram", channelId: channel.id });
        } catch (err) {
          const error = err instanceof Error ? err.message : "unknown";
          results.push({
            ok: false,
            provider: "telegram",
            channelId: channel.id,
            error,
          });
        }
      }

      if (channel.provider === "slack" && hasSlackCredentials(channel)) {
        const slackCard = formatDecisionCardForSlack(card);
        try {
          const botToken = channel.secrets.botToken?.trim() || "";
          const slackChannelId = String(channel.config.channelId || "").trim();
          const result = await postSlackMessage(
            botToken,
            slackChannelId,
            slackCard.text,
            slackCard.blocks
          );
          if (result.ok) {
            results.push({ ok: true, provider: "slack", channelId: channel.id });
          } else {
            results.push({
              ok: false,
              provider: "slack",
              channelId: channel.id,
              error: result.error,
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : "unknown";
          results.push({
            ok: false,
            provider: "slack",
            channelId: channel.id,
            error,
          });
        }
      }
    }

    if (results.some((r) => !r.ok)) {
      await appendAuditEvent({
        orgId: approval.orgId,
        employeeId: approval.employeeId ?? "",
        credentialId: approval.credentialId ?? "",
        action: "notification.delivery_failed",
        purpose: approval.purpose,
        summary: "決裁投票カードの配信に失敗",
        metadata: {
          approvalId: approval.id,
          tier: metadata.tier,
          errors: results
            .filter((r) => !r.ok)
            .map((r) => ({ provider: r.provider, error: r.error })),
        },
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown";
    results.push({ ok: false, provider: "telegram", error });
  }

  return results;
}

/**
 * Check if an approval is a decision request.
 */
export function isDecisionRequest(approval: ApprovalRequest): boolean {
  if (!isDecisionWorkflowEnabled()) return false;
  const metadata = approval.metadata as Record<string, unknown> | null;
  return metadata?.type === "decision_request" && !!metadata?.tier;
}
