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
      setMessage("会話投稿 Slack を保存しました（承認通知とは別の保存先です）");
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
          <h2 className="font-medium">会話投稿 Slack</h2>
          <p className="text-xs muted mt-1">
            comm.send / slack.post がegress許可後に chat.postMessage します。承認カードはこのトークンを使いません。
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
      <p className="text-[11px] faint">
        承認通知のSlack設定とは別ストアです。同じBot tokenを貼っても構いません。社員本人として出す場合は各社員証で Slack 連携する。
      </p>
      <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
        保存
      </button>
    </section>
  );
}
