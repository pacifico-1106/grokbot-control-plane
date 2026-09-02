"use client";

import { useState } from "react";

type SourceType = "document" | "voice" | "text";

export function OpsDocLocationForm({ initial }: { initial: string | null }) {
  const [sourceType, setSourceType] = useState<SourceType>("text");
  const [location, setLocation] = useState(initial || "");
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin-mcp/ops-doc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType,
          location,
          text,
          transcript,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "保存に失敗しました");
      setMessage(body.noticeJa || "正本を控えました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="muted">正本の種類</span>
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SourceType)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          disabled={busy}
        >
          <option value="document">ドキュメント</option>
          <option value="voice">音声 / 書き起こし</option>
          <option value="text">テキスト / 会話ログ</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="muted">場所（Drive / Supabase など。なくても進めます）</span>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          placeholder="例: Drive / 会社オペレーション / 職務.md"
          disabled={busy}
        />
      </label>
      {sourceType === "voice" ? (
        <label className="block text-sm">
          <span className="muted">書き起こし</span>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm min-h-[96px]"
            placeholder="音声の書き起こし、または会話のメモ"
            disabled={busy}
          />
        </label>
      ) : (
        <label className="block text-sm">
          <span className="muted">{sourceType === "document" ? "ドキュメント本文" : "テキスト"}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm min-h-[96px]"
            placeholder="職務の説明、会話ログ、または本文"
            disabled={busy}
          />
        </label>
      )}
      <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={() => void save()}>
        正本を控える
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
