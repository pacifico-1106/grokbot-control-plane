/**
 * Slack implementation of ApprovalDeliveryAdapter.
 * P0 Item 4: Channel-agnostic delivery for Slack approval workflows.
 *
 * Security:
 * - Checks is_ext_shared/is_shared before delivery (fail-closed)
 * - Never posts approval cards to Slack Connect shared channels
 * - Validates recipient channel membership before DM delivery
 */

import type { ApprovalRequest, Employee, NotificationProvider } from "@/lib/types";
import type {
  ApprovalDeliveryAdapter,
  DeliveryRecipient,
  DeliveryResult,
  InteractionNormalizeInput,
  NormalizedInteraction,
  SendCardOptions,
  SendDecisionOptions,
  SendDmOptions,
  SendToThreadOptions,
  UpdateProgressOptions,
} from "./delivery-adapter";
import { registerDeliveryAdapter } from "./delivery-adapter";
import {
  sendApprovalToSlackChannel,
  editSlackApprovalForChannel,
  editSlackWorkflowProgress,
  type WorkflowProgressDisplay,
} from "./slack";
import { getNotificationChannelSecretsById } from "@/lib/data/notification-channels";
import { getEnabledNotificationChannels, type NotificationChannelRuntime } from "@/lib/data/notification-channels";

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;

interface SlackChannelInfo {
  ok: boolean;
  channel?: {
    id?: string;
    is_shared?: boolean;
    is_ext_shared?: boolean;
    is_pending_ext_shared?: boolean;
  };
  error?: string;
}

export class SlackDeliveryAdapter implements ApprovalDeliveryAdapter {
  readonly provider: NotificationProvider = "slack";
  readonly channelId: string;
  readonly orgId: string;

  private channel: NotificationChannelRuntime | null = null;
  private channelLoaded = false;

  constructor(channelId: string, orgId: string) {
    this.channelId = channelId;
    this.orgId = orgId;
  }

  private async loadChannel(): Promise<NotificationChannelRuntime | null> {
    if (this.channelLoaded) return this.channel;
    this.channelLoaded = true;

    const channels = await getEnabledNotificationChannels(this.orgId);
    this.channel = channels.find((c) => c.id === this.channelId && c.provider === "slack") ?? null;
    return this.channel;
  }

  private async getBotToken(): Promise<string | null> {
    const channel = await this.loadChannel();
    return channel?.secrets.botToken ?? null;
  }

  private async getSlackChannelId(): Promise<string | null> {
    const channel = await this.loadChannel();
    return (channel?.config.channelId as string) ?? null;
  }

  async sendCard(options: SendCardOptions): Promise<DeliveryResult> {
    const channel = await this.loadChannel();
    if (!channel) {
      return { ok: false, error: "channel_not_found", skipped: true };
    }

    const sharedCheck = await this.isSharedChannel();
    if (sharedCheck.shared) {
      return {
        ok: false,
        error: "shared_channel_blocked",
        skipped: true,
      };
    }

    const result = await sendApprovalToSlackChannel(
      options.approval,
      options.employee,
      channel,
      { workflow: options.workflow }
    );

    return {
      ok: result.ok,
      ts: result.ts,
      channel: result.channel,
      error: result.error,
      skipped: result.skipped,
      recipient: {
        kind: "channel",
        provider: "slack",
        channelId: this.channelId,
      },
    };
  }

  async updateProgress(options: UpdateProgressOptions): Promise<DeliveryResult> {
    const channel = await this.loadChannel();
    if (!channel) {
      return { ok: false, error: "channel_not_found", skipped: true };
    }

    const result = await editSlackWorkflowProgress(
      options.approval,
      options.employee,
      channel,
      options.workflow
    );

    return {
      ok: result.ok,
      ts: result.ts,
      channel: result.channel,
      error: result.error,
      recipient: {
        kind: "channel",
        provider: "slack",
        channelId: this.channelId,
      },
    };
  }

  async sendDecision(options: SendDecisionOptions): Promise<DeliveryResult> {
    const channel = await this.loadChannel();
    if (!channel) {
      return { ok: false, error: "channel_not_found", skipped: true };
    }

    const result = await editSlackApprovalForChannel(
      options.approval,
      options.decision,
      options.actor,
      channel
    );

    return {
      ok: result.ok,
      ts: result.ts,
      channel: result.channel,
      error: result.error,
      skipped: result.skipped,
      recipient: {
        kind: "channel",
        provider: "slack",
        channelId: this.channelId,
      },
    };
  }

  async sendDm(recipient: DeliveryRecipient, options: SendDmOptions): Promise<DeliveryResult> {
    if (!recipient.externalUserId) {
      return { ok: false, error: "no_external_user_id" };
    }

    const botToken = await this.getBotToken();
    if (!botToken) {
      return { ok: false, error: "no_bot_token", skipped: true };
    }

    const openResponse = await fetch(`${SLACK_API}/conversations.open`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ users: recipient.externalUserId }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const openBody = (await openResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      channel?: { id?: string };
      error?: string;
    };

    if (!openBody.ok || !openBody.channel?.id) {
      return { ok: false, error: openBody.error || "dm_open_failed" };
    }

    const dmChannelId = openBody.channel.id;

    const postResponse = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: dmChannelId,
        text: options.text,
        blocks: options.blocks,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const postBody = (await postResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      channel?: string;
      error?: string;
    };

    if (!postBody.ok) {
      return { ok: false, error: postBody.error || "dm_post_failed" };
    }

    return {
      ok: true,
      ts: postBody.ts,
      channel: postBody.channel,
      recipient: {
        kind: "dm",
        provider: "slack",
        channelId: this.channelId,
        externalUserId: recipient.externalUserId,
      },
    };
  }

  async sendToThread(options: SendToThreadOptions): Promise<DeliveryResult> {
    const botToken = await this.getBotToken();
    const slackChannelId = await this.getSlackChannelId();

    if (!botToken || !slackChannelId) {
      return { ok: false, error: "missing_credentials", skipped: true };
    }

    const sharedCheck = await this.isSharedChannel();
    if (sharedCheck.shared) {
      return {
        ok: false,
        error: "shared_channel_thread_blocked",
        skipped: true,
      };
    }

    const postResponse = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: slackChannelId,
        thread_ts: options.threadTs,
        text: options.text,
        blocks: options.blocks,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const postBody = (await postResponse.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      channel?: string;
      error?: string;
    };

    if (!postBody.ok) {
      return { ok: false, error: postBody.error || "thread_post_failed" };
    }

    return {
      ok: true,
      ts: postBody.ts,
      channel: postBody.channel,
      recipient: {
        kind: "thread",
        provider: "slack",
        channelId: this.channelId,
        threadTs: options.threadTs,
      },
    };
  }

  normalizeInteraction(input: InteractionNormalizeInput): NormalizedInteraction | null {
    if (input.provider !== "slack") return null;

    const payload = input.rawPayload as {
      user?: { id?: string; team_id?: string };
      team?: { id?: string };
      channel?: { id?: string };
      container?: { message_ts?: string; channel_id?: string };
      message?: { ts?: string };
      actions?: Array<{ action_id?: string; value?: string }>;
      response_url?: string;
    };

    const action = (payload.actions || [])[0];
    if (!action) return null;

    return {
      userId: payload.user?.id || "",
      teamId: payload.user?.team_id || payload.team?.id || "",
      channelId: payload.channel?.id || payload.container?.channel_id || "",
      messageTs: payload.message?.ts || payload.container?.message_ts || "",
      actionId: action.action_id || "",
      actionValue: action.value || "",
      responseUrl: payload.response_url || "",
    };
  }

  async canDeliverToRecipient(recipient: DeliveryRecipient): Promise<boolean> {
    if (recipient.provider !== "slack") return false;

    const botToken = await this.getBotToken();
    if (!botToken) return false;

    if (recipient.kind === "dm") {
      return true;
    }

    const sharedCheck = await this.isSharedChannel();
    return !sharedCheck.shared;
  }

  async isSharedChannel(): Promise<{ shared: boolean; reason?: string }> {
    const botToken = await this.getBotToken();
    const slackChannelId = await this.getSlackChannelId();

    if (!botToken || !slackChannelId) {
      return { shared: true, reason: "cannot_verify" };
    }

    try {
      const response = await fetch(
        `${SLACK_API}/conversations.info?channel=${encodeURIComponent(slackChannelId)}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${botToken}`,
          },
          signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
        }
      );

      const body = (await response.json().catch(() => ({}))) as SlackChannelInfo;

      if (!body.ok) {
        return { shared: true, reason: body.error || "api_error" };
      }

      const channel = body.channel;
      if (!channel) {
        return { shared: true, reason: "channel_not_found" };
      }

      if (channel.is_ext_shared) {
        return { shared: true, reason: "slack_connect_channel" };
      }

      if (channel.is_shared) {
        return { shared: true, reason: "externally_shared_channel" };
      }

      if (channel.is_pending_ext_shared) {
        return { shared: true, reason: "pending_external_share" };
      }

      return { shared: false };
    } catch (error) {
      return { shared: true, reason: "verification_failed" };
    }
  }
}

async function createSlackDeliveryAdapter(
  channelId: string,
  orgId: string
): Promise<SlackDeliveryAdapter | null> {
  return new SlackDeliveryAdapter(channelId, orgId);
}

registerDeliveryAdapter("slack", createSlackDeliveryAdapter);
