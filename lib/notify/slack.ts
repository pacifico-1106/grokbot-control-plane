import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";
import {
  getNotificationDelivery,
  recordNotificationDelivery,
  type NotificationChannelRuntime,
} from "@/lib/data/notification-channels";
import type { ApprovalRequest, Employee } from "@/lib/types";

const SLACK_TIMEOUT_MS = 5_000;
const SLACK_API = "https://slack.com/api";

export type SlackNotifyResult = {
  ok: boolean;
  skipped?: boolean;
  ts?: string;
  channel?: string;
  error?: string;
};

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
};

function target(channel: NotificationChannelRuntime) {
  const botToken = channel.secrets.botToken?.trim() || "";
  const signingSecret = channel.secrets.signingSecret?.trim() || "";
  const channelId = String(channel.config.channelId || "").trim();
  const allowedUserIds = Array.isArray(channel.config.allowedUserIds)
    ? channel.config.allowedUserIds.map(String)
    : [];
  return { botToken, signingSecret, channelId, allowedUserIds };
}

export function escapeSlackMrkdwn(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): boolean {
  const signingSecret = input.signingSecret?.trim() || "";
  const timestamp = String(input.timestamp || "");
  const signature = String(input.signature || "");
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSec - ts) > 5 * 60) return false;
  const basestring = `v0:${timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function callSlack(
  token: string,
  method: "chat.postMessage" | "chat.update",
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: SlackApiResponse; error?: string }> {
  if (!token) return { ok: false, error: "slack_bot_token_missing" };
  try {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as SlackApiResponse;
    if (!body.ok) {
      return { ok: false, error: body.error || `slack_http_${response.status}` };
    }
    return { ok: true, result: body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "slack_fetch_failed",
    };
  }
}

function approvalValue(approval: ApprovalRequest): string {
  return approval.telegramRef || approval.id.slice(0, 12);
}

function dashboardUrl(): string {
  return `${getAppOrigin()}/app/approvals`;
}

function approvalFallbackText(approval: ApprovalRequest): string {
  return `承認依頼: ${approval.title} [risk: ${approval.risk}]`;
}

function approvalBlocks(
  approval: ApprovalRequest,
  employee: Employee | null,
  options?: { resolved?: { label: string; actor: string } }
) {
  const summary = [
    `*承認依頼* \`#${escapeSlackMrkdwn(approval.id.slice(0, 8))}\`  risk: ${escapeSlackMrkdwn(approval.risk)}`,
    `社員: ${escapeSlackMrkdwn(employee?.displayName || approval.employeeId)}`,
    `ツール: \`${escapeSlackMrkdwn(approval.tool || "unknown")}\``,
    `目的: ${escapeSlackMrkdwn(approval.purpose)}`,
    escapeSlackMrkdwn(truncate(approval.summary, 400)),
  ].join("\n");
  const section = {
    type: "section",
    text: { type: "mrkdwn", text: summary },
  };
  if (options?.resolved) {
    return [
      section,
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeSlackMrkdwn(options.resolved.label)}*\n処理者: ${escapeSlackMrkdwn(options.resolved.actor)}`,
        },
      },
    ];
  }
  const value = approvalValue(approval);
  return [
    section,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "承認" },
          style: "primary",
          action_id: "staffpass_approve",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "却下" },
          style: "danger",
          action_id: "staffpass_reject",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "修正依頼" },
          action_id: "staffpass_revise",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "ダッシュボード" },
          url: dashboardUrl(),
          action_id: "staffpass_dashboard",
        },
      ],
    },
  ];
}

export async function sendApprovalToSlackChannel(
  approval: ApprovalRequest,
  employee: Employee | null,
  channel: NotificationChannelRuntime
): Promise<SlackNotifyResult> {
  const cfg = target(channel);
  if (!cfg.botToken || !cfg.channelId || !approvalValue(approval)) {
    return { ok: false, skipped: true };
  }
  const sent = await callSlack(cfg.botToken, "chat.postMessage", {
    channel: cfg.channelId,
    text: approvalFallbackText(approval),
    blocks: approvalBlocks(approval, employee),
  });
  const ts = sent.result?.ts;
  const slackChannel = sent.result?.channel;
  if (!sent.ok || !ts || !slackChannel) {
    return { ok: false, error: sent.error || "slack_message_missing" };
  }
  await recordNotificationDelivery({
    approval,
    channelId: channel.id,
    provider: "slack",
    externalMessageId: ts,
    context: { channel: slackChannel },
  });
  return { ok: true, ts, channel: slackChannel };
}

export async function editSlackApprovalForChannel(
  approval: ApprovalRequest,
  decision: "approved" | "rejected" | "revision_requested",
  actor: string,
  channel: NotificationChannelRuntime
): Promise<SlackNotifyResult> {
  const cfg = target(channel);
  const delivery = await getNotificationDelivery({
    approvalId: approval.id,
    channelId: channel.id,
  });
  const ts = delivery?.externalMessageId || "";
  const slackChannel = String(delivery?.context.channel || cfg.channelId || "");
  if (!cfg.botToken || !ts || !slackChannel) return { ok: false, skipped: true };
  const label =
    decision === "approved"
      ? "承認済み"
      : decision === "rejected"
        ? "却下"
        : "修正依頼";
  const edited = await callSlack(cfg.botToken, "chat.update", {
    channel: slackChannel,
    ts,
    text: `${label}: ${approval.title}`,
    blocks: approvalBlocks(approval, null, { resolved: { label, actor } }),
  });
  return edited.ok
    ? { ok: true, ts, channel: slackChannel }
    : { ok: false, error: edited.error };
}

export async function sendSlackTextToChannel(
  channel: NotificationChannelRuntime,
  text: string
): Promise<SlackNotifyResult> {
  const cfg = target(channel);
  if (!cfg.botToken || !cfg.channelId) return { ok: false, skipped: true };
  const sent = await callSlack(cfg.botToken, "chat.postMessage", {
    channel: cfg.channelId,
    text,
  });
  return sent.ok
    ? { ok: true, ts: sent.result?.ts, channel: sent.result?.channel }
    : { ok: false, error: sent.error };
}
