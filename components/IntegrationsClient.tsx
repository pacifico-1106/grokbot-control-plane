"use client";

import { useState } from "react";
import type { GatewayLinkStatus, IntegrationMode } from "@/lib/types";

const STATUS_LABEL: Record<GatewayLinkStatus, string> = {
  linked: "連携済み",
  pending: "連携待ち（Grok Botへ→戻る）",
  disconnected: "未連携",
};

export function IntegrationsClient({
  initialStatus,
  initialMode,
}: {
  initialStatus: GatewayLinkStatus;
  initialMode: IntegrationMode;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [mode, setMode] = useState<IntegrationMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function run(action: "connect" | "handshake" | "disconnect") {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/gateway/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, mode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "failed");
      setStatus(body.status);
      setMessage(body.message || "");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <section className="surface p-5">
        <h2 className="text-sm font-medium">導入モード</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          Managed（こちらで用意）または BYO Grok Bot（持ち込み）。
        </p>
        <div className="mt-4 space-y-3">
          <label className="flex gap-3 rounded-lg border border-[var(--border)] p-3 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === "managed"}
              onChange={() => setMode("managed")}
              className="mt-1"
            />
            <div>
              <div className="text-sm">Managed</div>
              <p className="text-xs muted mt-1">
                弊社が Grok Bot をセットアップし、制御面に接続済みでお渡しします。
              </p>
            </div>
          </label>
          <label className="flex gap-3 rounded-lg border border-[var(--border)] p-3 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === "byo"}
              onChange={() => setMode("byo")}
              className="mt-1"
            />
            <div>
              <div className="text-sm">BYO Grok Bot</div>
              <p className="text-xs muted mt-1">
                既存ワークスペースを持ち込み。社員証ゲートと監査のみ接続します。
              </p>
            </div>
          </label>
        </div>
      </section>

      <section className="surface p-5">
        <h2 className="text-sm font-medium">Grok Bot 連携ステータス</h2>
        <p className="mt-2 text-sm muted">
          ステータスマシン: disconnected → pending（連携へ） → linked（戻る）
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`chip ${
              status === "linked"
                ? "chip-ok"
                : status === "pending"
                  ? "chip-warn"
                  : ""
            }`}
          >
            {STATUS_LABEL[status]}
          </span>
          <span className="text-xs faint font-mono">{status}</span>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={busy || status === "linked"}
            onClick={() => void run("connect")}
          >
            Grok Botへ連携
          </button>
          <button
            type="button"
            className="btn btn-ghost text-sm"
            disabled={busy || status !== "pending"}
            onClick={() => void run("handshake")}
          >
            戻る（連携完了）
          </button>
          <button
            type="button"
            className="btn btn-ghost text-sm"
            disabled={busy || status === "disconnected"}
            onClick={() => void run("disconnect")}
          >
            切断
          </button>
        </div>
        {message ? <p className="mt-3 text-xs muted">{message}</p> : null}
        <p className="mt-4 text-xs faint leading-relaxed">
          本番では Cursor Grok Bot パートナー API の OAuth / ワークスペース紐付けに置き換えます（現状はデモ状態機械）。
        </p>
      </section>
    </div>
  );
}
