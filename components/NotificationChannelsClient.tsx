"use client";

import { useState } from "react";
import type { NotificationChannel, NotificationProvider } from "@/lib/types";

type FormState = {
  enabled: boolean;
  label: string;
  destination: string;
  allowedUsers: string;
  primarySecret: string;
  secondarySecret: string;
};

function initial(provider: NotificationProvider, channels: NotificationChannel[]): FormState {
  const channel = channels.find((item) => item.provider === provider);
  return {
    enabled: channel?.enabled ?? false,
    label: channel?.label || (provider === "telegram" ? "承認用Telegram" : "承認用LINE"),
    destination: String(channel?.config[provider === "telegram" ? "chatId" : "destinationId"] || ""),
    allowedUsers: Array.isArray(channel?.config.allowedUserIds) ? channel!.config.allowedUserIds.map(String).join(",") : "",
    primarySecret: "",
    secondarySecret: "",
  };
}

export function NotificationChannelsClient({ initialChannels }: { initialChannels: NotificationChannel[] }) {
  const [channels, setChannels] = useState(initialChannels);
  const [forms, setForms] = useState<Record<NotificationProvider, FormState>>({
    telegram: initial("telegram", initialChannels),
    line: initial("line", initialChannels),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function update(provider: NotificationProvider, patch: Partial<FormState>) {
    setForms((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  }

  async function save(provider: NotificationProvider) {
    setBusy(provider);
    setMessage("");
    const form = forms[provider];
    const payload = provider === "telegram"
      ? { provider, enabled: form.enabled, label: form.label, chatId: form.destination, allowedUserIds: form.allowedUsers, botToken: form.primarySecret }
      : { provider, enabled: form.enabled, label: form.label, destinationId: form.destination, allowedUserIds: form.allowedUsers, channelAccessToken: form.primarySecret, channelSecret: form.secondarySecret };
    try {
      const response = await fetch("/api/settings/notification-channels", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setChannels((current) => [...current.filter((item) => item.provider !== provider), body.channel]);
      update(provider, { primarySecret: "", secondarySecret: "" });
      setMessage(body.webhook?.ok === false ? `保存しましたがWebhook登録に失敗: ${body.webhook.error}` : "保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function test(provider: NotificationProvider) {
    setBusy(`${provider}-test`);
    setMessage("");
    try {
      const response = await fetch(`/api/settings/notification-channels/${provider}/test`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "テストに失敗しました");
      setMessage(`${provider === "telegram" ? "Telegram" : "LINE"}へテスト通知を送信しました`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "テストに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <p className="surface p-3 text-sm">{message}</p> : null}
      <div className="grid lg:grid-cols-2 gap-4">
        {(["telegram", "line"] as const).map((provider) => {
          const form = forms[provider];
          const saved = channels.find((item) => item.provider === provider);
          const isTelegram = provider === "telegram";
          return (
            <section key={provider} className="surface p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div><h2 className="font-medium">{isTelegram ? "Telegram" : "LINE"}</h2><p className="text-xs muted mt-1">この組織専用の承認通知</p></div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => update(provider, { enabled: event.target.checked })} />有効</label>
              </div>
              <label className="block text-xs muted">表示名<input className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm" value={form.label} onChange={(event) => update(provider, { label: event.target.value })} /></label>
              <label className="block text-xs muted">{isTelegram ? "承認グループ chat ID" : "送信先 group / room / user ID"}<input className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono" value={form.destination} onChange={(event) => update(provider, { destination: event.target.value })} placeholder={isTelegram ? "-100..." : "C... / R... / U..."} /></label>
              <label className="block text-xs muted">許可user ID（カンマ区切り、空なら送信先内の全員）<input className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono" value={form.allowedUsers} onChange={(event) => update(provider, { allowedUsers: event.target.value })} /></label>
              <label className="block text-xs muted">{isTelegram ? "Bot token" : "Channel access token"}<input type="password" autoComplete="new-password" className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm" value={form.primarySecret} onChange={(event) => update(provider, { primarySecret: event.target.value })} placeholder={saved?.hasCredentials ? "設定済み（変更時のみ入力）" : "未設定"} /></label>
              {!isTelegram ? <label className="block text-xs muted">Channel secret<input type="password" autoComplete="new-password" className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm" value={form.secondarySecret} onChange={(event) => update(provider, { secondarySecret: event.target.value })} placeholder={saved?.hasCredentials ? "設定済み（変更時のみ入力）" : "未設定"} /></label> : null}
              {saved ? <p className="text-[11px] faint break-all">Webhook: {saved.webhookPath}</p> : null}
              <div className="flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy !== null} onClick={() => void save(provider)}>保存</button><button className="btn btn-ghost" disabled={busy !== null || !saved?.enabled} onClick={() => void test(provider)}>テスト送信</button></div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
