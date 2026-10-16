/**
 * Approver notice when an AI→AI Slack wake thread hits the cap.
 * Routes through the org's existing approval inbox (same order as stuck-notify:
 * employee approval channel → org default → first enabled). Slack cards include
 * a human-only stop button. Never includes message body / tokens.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getEmployee } from "@/lib/data/employees";
import { getEnabledNotificationChannels, type NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { resolveAppOrigin } from "@/lib/app-url";
import { isAiPeerWakeThreadGuardEnabled } from "@/lib/feature-flags";

export const PEER_WAKE_STOP_SLACK_ACTION_ID = "staffpass_peer_wake_stop";

export type PeerWakeCapNoticeInput = {
  orgId: string;
  speakerEmployeeId: string;
  targetEmployeeId: string;
  channelId: string;
  threadTs: string | null;
  eventId: string;
  stopRef: string;
  count: number;
  cap: number;
};

type Deps = {
  listChannels: (orgId: string) => Promise<NotificationChannelRuntime[]>;
  sendSlack: (
    channel: NotificationChannelRuntime,
    text: string,
    blocks: Array<Record<string, unknown>>
  ) => Promise<{ ok: boolean; error?: string }>;
  sendText: (channel: NotificationChannelRuntime, text: string) => Promise<{ ok: boolean; error?: string }>;
  audit: typeof appendAuditEvent;
};

const DEFAULT_DEPS: Deps = {
  listChannels: getEnabledNotificationChannels,
  sendSlack: async (channel, text, blocks) => {
    const { sendSlackBlocksToChannel } = await import("@/lib/notify/slack");
    return sendSlackBlocksToChannel(channel, text, blocks);
  },
  sendText: async (channel, text) => {
    if (channel.provider === "telegram") return (await import("@/lib/notify/telegram")).sendTelegramTextToChannel(channel, text);
    if (channel.provider === "line") return (await import("@/lib/notify/line")).sendLineText(channel, text);
    const { sendSlackTextToChannel } = await import("@/lib/notify/slack");
    return sendSlackTextToChannel(channel, text);
  },
  audit: appendAuditEvent,
};

let deps: Deps = DEFAULT_DEPS;

export function setPeerWakeNoticeDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

export function buildPeerWakeCapNoticeJa(input: PeerWakeCapNoticeInput): string {
  const thread = input.threadTs ? `スレッド ${input.threadTs}` : "チャンネル直下（時間窓）";
  return [
    `AI社員同士の起動が上限（${input.cap}回）に達したため、この会話ではこれ以上起こしません。`,
    `チャンネル: ${input.channelId}`,
    thread,
    `起動回数: ${input.count}/${input.cap}`,
    `止める場合は下のボタン、または管理画面（つながり）から。人からのメンションは通常どおりです。`,
  ].join("\n");
}

function stopBlocks(input: PeerWakeCapNoticeInput, text: string): Array<Record<string, unknown>> {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "この会話を止める" },
          style: "danger",
          action_id: PEER_WAKE_STOP_SLACK_ACTION_ID,
          value: input.stopRef,
          confirm: {
            title: { type: "plain_text", text: "AI同士の会話を止める" },
            text: { type: "mrkdwn", text: "このスレッドでは AI 社員同士の起動を止めます。人からのメンションは続きます。解除は管理画面からのみです。" },
            confirm: { type: "plain_text", text: "止める" },
            deny: { type: "plain_text", text: "やめる" },
          },
        },
        {
          type: "button",
          text: { type: "plain_text", text: "管理画面" },
          url: `${resolveAppOrigin()}/app/settings#ai-peer-wake`,
          action_id: "staffpass_dashboard",
        },
      ],
    },
  ];
}

async function pickChannel(
  orgId: string,
  employeeApprovalChannelId?: string | null
): Promise<NotificationChannelRuntime | null> {
  const channels = (await deps.listChannels(orgId)).filter((c) => c.enabled);
  if (!channels.length) return null;
  if (employeeApprovalChannelId) {
    const preferred = channels.find((c) => c.id === employeeApprovalChannelId);
    if (preferred) return preferred;
  }
  return channels.find((c) => c.isDefault) ?? channels[0] ?? null;
}

export async function notifyPeerWakeCap(input: PeerWakeCapNoticeInput): Promise<{ status: string }> {
  if (!isAiPeerWakeThreadGuardEnabled()) return { status: "flag_off" };
  if (!input.orgId || !/^[0-9a-f]{16}$/i.test(input.stopRef)) return { status: "invalid" };
  const text = buildPeerWakeCapNoticeJa(input);
  const speaker = await getEmployee(input.speakerEmployeeId, input.orgId).catch(() => null);
  const channel = await pickChannel(orgIdOrEmpty(input.orgId), speaker?.approvalChannelId);
  let status = "undelivered";
  if (channel) {
    const sent =
      channel.provider === "slack"
        ? await deps.sendSlack(channel, text, stopBlocks(input, text)).catch(() => ({ ok: false as const }))
        : await deps.sendText(channel, `${text}\n管理画面: ${resolveAppOrigin()}/app/settings#ai-peer-wake`).catch(() => ({ ok: false as const }));
    status = sent.ok ? "sent_approver" : "undelivered";
  }
  await deps
    .audit({
      orgId: input.orgId,
      employeeId: input.targetEmployeeId || input.speakerEmployeeId || null,
      credentialId: null,
      action: "slack.peer_wake.cap_notified",
      purpose: "slack.peer_wake",
      summary: "AI同士の起動上限に達したため承認者に通知した",
      metadata: {
        reason: "thread_capped",
        channel: input.channelId,
        thread_ts: input.threadTs,
        eventId: input.eventId,
        stopRef: input.stopRef,
        count: input.count,
        cap: input.cap,
        noticeStatus: status,
        speakerEmployeeId: input.speakerEmployeeId,
        targetEmployeeId: input.targetEmployeeId,
      },
    })
    .catch(() => undefined);
  return { status };
}

function orgIdOrEmpty(orgId: string): string {
  return orgId.trim();
}
