import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendAuditEvent,
  getNotificationChannelByWebhookRef,
  isTokyo307PilotOrg,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { ensureGlobalTelegramWebhook, registerTelegramWebhook } from "@/lib/notify/telegram";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { channelErrorPayload } from "@/lib/notify/channel-errors";
import { validateSlackChannelNotExternal, getSlackBotTeamId } from "@/lib/slack/channel-validation";
import { getNotificationChannelSecretsById as getNotificationChannelSecrets } from "@/lib/data/notification-channels";
import type { NotificationProvider } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  return NextResponse.json({ ok: true, channels: await listNotificationChannels(gate.orgId) });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = body.provider as NotificationProvider;
  if (provider !== "telegram" && provider !== "line" && provider !== "slack") {
    return NextResponse.json(channelErrorPayload("invalid_provider"), { status: 400 });
  }
  const enabled = body.enabled === true;
  const allowedUserIds = Array.isArray(body.allowedUserIds)
    ? body.allowedUserIds.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 100)
    : String(body.allowedUserIds || "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 100);
  const config = provider === "telegram"
    ? { chatId: String(body.chatId || "").trim(), allowedUserIds }
    : provider === "line"
      ? { destinationId: String(body.destinationId || "").trim(), allowedUserIds }
      : { channelId: String(body.channelId || "").trim(), allowedUserIds };
  const destination = provider === "telegram"
    ? config.chatId
    : provider === "line"
      ? config.destinationId
      : config.channelId;
  const inboxId = String(body.id || "").trim();
  const channels = await listNotificationChannels(gate.orgId);
  const existingChannel = inboxId
    ? channels.find((channel) => channel.id === inboxId)
    : undefined;
  const botToken = provider === "telegram" ? String(body.botToken || "").trim() : "";
  const envReuseFirstInbox =
    provider === "telegram" &&
    enabled &&
    !botToken &&
    (await isTokyo307PilotOrg(gate.orgId)) &&
    !channels.some((channel) => channel.provider === "telegram" && channel.id !== existingChannel?.id);
  if (enabled && !destination && !envReuseFirstInbox) {
    return NextResponse.json(channelErrorPayload("destination_required"), { status: 400 });
  }
  const secrets: Record<string, string> = provider === "telegram"
    ? {
        botToken,
        ...(botToken && !existingChannel?.hasCredentials
          ? { webhookSecret: randomBytes(32).toString("hex") }
          : {}),
      }
    : provider === "line"
      ? {
          channelAccessToken: String(body.channelAccessToken || "").trim(),
          channelSecret: String(body.channelSecret || "").trim(),
        }
      : {
          botToken: String(body.botToken || "").trim(),
          signingSecret: String(body.signingSecret || "").trim(),
        };
  // P0 Item 5: Reject Slack Connect / externally shared channels
  // This check is always enforced at registration time (not behind flag) for security
  // Item 7: Load stored bot token when secrets.botToken is empty
  // Item 8: Capture expectedTeamId via auth.test at registration
  let slackTeamId: string | undefined;
  if (provider === "slack" && enabled && destination) {
    let slackBotToken = secrets.botToken;
    // If no new token provided, load the stored token for validation
    if (!slackBotToken && existingChannel?.id) {
      const storedSecrets = await getNotificationChannelSecrets(gate.orgId, existingChannel.id);
      slackBotToken = storedSecrets.botToken || "";
    }
    // Fail closed if no token available
    if (!slackBotToken) {
      return NextResponse.json(
        channelErrorPayload("bot_token_required", "Slackボットトークンが必要です"),
        { status: 400 }
      );
    }
    // Validate channel is not externally shared
    const validation = await validateSlackChannelNotExternal(slackBotToken, destination);
    if (!validation.ok) {
      await appendAuditEvent({
        orgId: gate.orgId,
        employeeId: null,
        credentialId: null,
        actorEmail: gate.email,
        action: "notification.channel_updated",
        purpose: null,
        summary: `Slack承認チャンネル登録拒否（外部共有チャンネル）`,
        metadata: {
          provider,
          channelId: destination,
          validationCode: validation.code,
          validationReason: validation.reason,
        },
      });
      return NextResponse.json(
        channelErrorPayload(
          validation.code,
          `外部共有チャンネル（Slack Connect）は承認インボックスとして使用できません: ${validation.reason}`
        ),
        { status: 400 }
      );
    }
    // Item 8: Capture team_id via auth.test to store as expectedTeamId
    const teamIdResult = await getSlackBotTeamId(slackBotToken);
    if (teamIdResult.ok) {
      slackTeamId = teamIdResult.teamId;
    } else {
      console.warn("slack_auth_test_failed", {
        channelId: destination,
        reason: teamIdResult.reason,
      });
    }
  }

  try {
    // Add expectedTeamId to Slack config if captured
    const finalConfig = provider === "slack" && slackTeamId
      ? { ...config, expectedTeamId: slackTeamId }
      : config;
    const saved = await upsertNotificationChannel({
      orgId: gate.orgId,
      ...(existingChannel?.id ? { id: existingChannel.id } : {}),
      provider,
      label: String(body.label || "").trim(),
      enabled,
      isDefault: body.isDefault === true,
      config: finalConfig,
      secrets,
    });
    let webhook: { ok: boolean; error?: string } | null = null;
    if (provider === "telegram" && enabled) {
      const runtime = await getNotificationChannelByWebhookRef("telegram", saved.webhookRef);
      webhook = runtime
        ? await registerTelegramWebhook(runtime, `${getAppOrigin()}${saved.webhookPath}`)
        : { ok: false, error: "channel_runtime_unavailable" };
    }
    // 既存の通知設定保存パス。グローバル fallback bot も同じ origin に webhook を張る。
    await ensureGlobalTelegramWebhook();
    await appendAuditEvent({
      orgId: gate.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: gate.email,
      action: "notification.channel_updated",
      purpose: null,
      summary: `${provider} 通知チャネルを${enabled ? "更新" : "無効化"}`,
      metadata: { channelId: saved.id, provider, enabled, webhookOk: webhook?.ok ?? null },
    });
    return NextResponse.json({ ok: true, channel: saved, webhook });
  } catch (error) {
    const code = error instanceof Error ? error.message : "notification_channel_save_failed";
    return NextResponse.json(channelErrorPayload(code), { status: 400 });
  }
}
