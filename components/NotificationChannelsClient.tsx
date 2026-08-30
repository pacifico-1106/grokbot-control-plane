"use client";

import { useMemo, useState } from "react";
import { channelErrorMessage } from "@/lib/notify/channel-errors";
import type { NotificationChannel, NotificationProvider } from "@/lib/types";

type InboxDraft = {
  key: string;
  id?: string;
  provider: NotificationProvider;
  enabled: boolean;
  isDefault: boolean;
  label: string;
  destination: string;
  allowedUsers: string;
  primarySecret: string;
  secondarySecret: string;
};

const PROVIDERS: NotificationProvider[] = ["telegram", "line", "slack"];

function defaultLabel(provider: NotificationProvider): string {
  if (provider === "telegram") return "承認用Telegram";
  if (provider === "line") return "承認用LINE";
  return "承認用Slack";
}

function destinationKey(provider: NotificationProvider): string {
  if (provider === "telegram") return "chatId";
  if (provider === "line") return "destinationId";
  return "channelId";
}

function providerTitle(provider: NotificationProvider): string {
  if (provider === "telegram") return "Telegram";
  if (provider === "line") return "LINE";
  return "Slack";
}

function providerHint(provider: NotificationProvider): string {
  if (provider === "slack") {
    return "ここに入れると、危ない操作のカードがこのチャンネルに届きます。社員の返信そのものは出ません。";
  }
  return "危ない操作のカードがここに届きます。会話の書き込みではありません。";
}

function destinationLabel(provider: NotificationProvider): string {
  if (provider === "telegram") return "承認グループ / DM chat ID";
  if (provider === "line") return "送信先 group / room / user ID";
  return "通知チャネル ID（C... / G... / D... / U...）";
}

function draftFromChannel(channel: NotificationChannel): InboxDraft {
  return {
    key: channel.id,
    id: channel.id,
    provider: channel.provider,
    enabled: channel.enabled,
    isDefault: channel.isDefault,
    label: channel.label || defaultLabel(channel.provider),
    destination: String(channel.config[destinationKey(channel.provider)] || ""),
    allowedUsers: Array.isArray(channel.config.allowedUserIds)
      ? channel.config.allowedUserIds.map(String).join(",")
      : "",
    primarySecret: "",
    secondarySecret: "",
  };
}

function emptyDraft(provider: NotificationProvider, makeDefault: boolean): InboxDraft {
  return {
    key: `new_${provider}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    provider,
    enabled: true,
    isDefault: makeDefault,
    label: defaultLabel(provider),
    destination: "",
    allowedUsers: "",
    primarySecret: "",
    secondarySecret: "",
  };
}

export function NotificationChannelsClient({ initialChannels }: { initialChannels: NotificationChannel[] }) {
  const [channels, setChannels] = useState(initialChannels);
  const [drafts, setDrafts] = useState<InboxDraft[]>(
    initialChannels.length
      ? initialChannels.map(draftFromChannel)
      : [emptyDraft("telegram", true)]
  );
  const [addProvider, setAddProvider] = useState<NotificationProvider>("telegram");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const savedById = useMemo(
    () => Object.fromEntries(channels.map((channel) => [channel.id, channel])),
    [channels]
  );

  function updateDraft(key: string, patch: Partial<InboxDraft>) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft))
    );
  }

  function addInbox() {
    const makeDefault = !drafts.some((draft) => draft.isDefault) && channels.every((row) => !row.isDefault);
    setDrafts((current) => [...current, emptyDraft(addProvider, makeDefault)]);
  }

  async function save(draft: InboxDraft) {
    setBusy(draft.key);
    setMessage("");
    const payload =
      draft.provider === "telegram"
        ? {
            id: draft.id,
            provider: draft.provider,
            enabled: draft.enabled,
            isDefault: draft.isDefault,
            label: draft.label,
            chatId: draft.destination,
            allowedUserIds: draft.allowedUsers,
            botToken: draft.primarySecret,
          }
        : draft.provider === "line"
          ? {
              id: draft.id,
              provider: draft.provider,
              enabled: draft.enabled,
              isDefault: draft.isDefault,
              label: draft.label,
              destinationId: draft.destination,
              allowedUserIds: draft.allowedUsers,
              channelAccessToken: draft.primarySecret,
              channelSecret: draft.secondarySecret,
            }
          : {
              id: draft.id,
              provider: draft.provider,
              enabled: draft.enabled,
              isDefault: draft.isDefault,
              label: draft.label,
              channelId: draft.destination,
              allowedUserIds: draft.allowedUsers,
              botToken: draft.primarySecret,
              signingSecret: draft.secondarySecret,
            };
    try {
      const response = await fetch("/api/settings/notification-channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(channelErrorMessage(body));
      const saved = body.channel as NotificationChannel;
      setChannels((current) => {
        const without = current.filter((item) => item.id !== saved.id);
        const next = [...without, saved];
        return saved.isDefault
          ? next.map((item) => (item.id === saved.id ? item : { ...item, isDefault: false }))
          : next;
      });
      setDrafts((current) =>
        current.map((item) => {
          if (item.key !== draft.key) {
            return saved.isDefault ? { ...item, isDefault: false } : item;
          }
          return {
            ...draftFromChannel(saved),
            key: item.key,
          };
        })
      );
      setMessage(
        body.webhook?.ok === false
          ? "保存しましたが Webhook の登録に失敗しました"
          : "保存しました"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(null);
    }
  }

  async function test(draft: InboxDraft) {
    setBusy(`${draft.key}-test`);
    setMessage("");
    try {
      const response = await fetch(`/api/settings/notification-channels/${draft.provider}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: draft.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(channelErrorMessage(body, "テストに失敗しました"));
      setMessage(`${providerTitle(draft.provider)}へテスト通知を送信しました`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "テストに失敗しました");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 mt-4">
      {message ? <p className="surface p-3 text-sm">{message}</p> : null}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-xs muted leading-relaxed">
          組織に複数の「承認を受け取る」インボックスを置けます。同じ Telegram Bot でも、DM とグループを分けられます。会話の書き込みは下の欄です。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            value={addProvider}
            onChange={(event) => setAddProvider(event.target.value as NotificationProvider)}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {providerTitle(provider)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost text-sm" onClick={addInbox}>
            承認を受け取るチャンネルを追加
          </button>
        </div>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        {drafts.map((draft) => {
          const saved = draft.id ? savedById[draft.id] : undefined;
          const isTelegram = draft.provider === "telegram";
          const isLine = draft.provider === "line";
          return (
            <section key={draft.key} className="surface p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">承認を受け取る（{providerTitle(draft.provider)}）</h2>
                  <p className="text-xs muted mt-1">{providerHint(draft.provider)}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => updateDraft(draft.key, { enabled: event.target.checked })}
                  />
                  有効
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDrafts((current) =>
                      current.map((item) =>
                        item.key === draft.key
                          ? { ...item, isDefault: checked }
                          : checked
                            ? { ...item, isDefault: false }
                            : item
                      )
                    );
                  }}
                />
                組織の既定インボックス
              </label>
              <label className="block text-xs muted">
                表示名
                <input
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                  value={draft.label}
                  onChange={(event) => updateDraft(draft.key, { label: event.target.value })}
                />
              </label>
              <label className="block text-xs muted">
                {destinationLabel(draft.provider)}
                <input
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono"
                  value={draft.destination}
                  onChange={(event) => updateDraft(draft.key, { destination: event.target.value })}
                  placeholder={isTelegram ? "-100... / 個人DM" : isLine ? "C... / R... / U..." : "C012..."}
                />
              </label>
              <label className="block text-xs muted">
                許可user ID（カンマ区切り、空なら送信先内の全員）
                <input
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono"
                  value={draft.allowedUsers}
                  onChange={(event) => updateDraft(draft.key, { allowedUsers: event.target.value })}
                />
              </label>
              <label className="block text-xs muted">
                {isTelegram ? "Bot token" : isLine ? "Channel access token" : "Bot token"}
                <input
                  type="password"
                  autoComplete="new-password"
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                  value={draft.primarySecret}
                  onChange={(event) => updateDraft(draft.key, { primarySecret: event.target.value })}
                  placeholder={saved?.hasCredentials ? "設定済み（変更時のみ入力）" : "未設定"}
                />
              </label>
              {!isTelegram ? (
                <label className="block text-xs muted">
                  {isLine ? "Channel secret" : "Signing secret"}
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                    value={draft.secondarySecret}
                    onChange={(event) => updateDraft(draft.key, { secondarySecret: event.target.value })}
                    placeholder={saved?.hasCredentials ? "設定済み（変更時のみ入力）" : "未設定"}
                  />
                </label>
              ) : null}
              {saved ? <p className="text-[11px] faint break-all">Webhook: {saved.webhookPath}</p> : null}
              {draft.provider === "slack" ? (
                <p className="text-[11px] faint leading-relaxed">
                  会話への書き込みは下の「チャンネルに書き込む」で設定します。同じ Bot token で構いません。
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" disabled={busy !== null} onClick={() => void save(draft)}>
                  保存
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy !== null || !saved?.enabled}
                  onClick={() => void test(draft)}
                >
                  テスト送信
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
