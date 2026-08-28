"use client";

import { useState } from "react";
import type { ConversationAdapter } from "@/lib/types";

export function ConversationAdaptersClient({
  initialAdapters,
}: {
  initialAdapters: ConversationAdapter[];
}) {
  const saved = initialAdapters.find((item) => item.surface === "slack");
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [label, setLabel] = useState(saved?.label || "Slack 会話投稿");
  const [botToken, setBotToken] = useState("");
  const [adapter, setAdapter] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/conversation-adapters", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "slack", enabled, label, botToken }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setAdapter(body.adapter);
      setBotToken("");
      setMessage("チャンネルへの書き込み設定を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface p-5 space-y-4 mt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">チャンネルに書き込む（会社のBot）</h2>
          <p className="text-xs muted mt-1">
            承認のあと、AI社員のメッセージがこのBot名義でチャンネルに出ます。xoxb。本人として出すなら社員証へ。
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          有効
        </label>
      </div>
      {message ? <p className="text-sm">{message}</p> : null}
      <label className="block text-xs muted">
        表示名
        <input
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="block text-xs muted">
        Bot token
        <input
          type="password"
          autoComplete="new-password"
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
          placeholder={adapter?.hasCredentials ? "設定済み（変更時のみ入力）" : "未設定"}
        />
      </label>
      <p className="text-[11px] faint leading-relaxed">
        上の「承認を受け取る」と同じ Bot token を入れて構いません。本人の名前で出す場合は、各社員証で Slack 連携します。
      </p>
      <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
        保存
      </button>
    </section>
  );
}
