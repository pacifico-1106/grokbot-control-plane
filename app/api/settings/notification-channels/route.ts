import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendAuditEvent,
  getNotificationChannelByWebhookRef,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { ensureGlobalTelegramWebhook, registerTelegramWebhook } from "@/lib/notify/telegram";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
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
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
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
  if (enabled && !destination) {
    return NextResponse.json({ error: "destination_required" }, { status: 400 });
  }
  const existingChannel = (await listNotificationChannels(gate.orgId)).find(
    (channel) => channel.provider === provider
  );
  const secrets: Record<string, string> = provider === "telegram"
    ? {
        botToken: String(body.botToken || "").trim(),
        ...(body.botToken && !existingChannel?.hasCredentials
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
  try {
    const saved = await upsertNotificationChannel({
      orgId: gate.orgId,
      provider,
      label: String(body.label || "").trim(),
      enabled,
      config,
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save_failed" },
      { status: 400 }
    );
  }
}
