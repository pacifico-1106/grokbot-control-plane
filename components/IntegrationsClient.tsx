"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  BindingStatus,
  EmployeeBinding,
  GatewayLinkStatus,
  IntegrationMode,
} from "@/lib/types";

const STATUS_LABEL: Record<GatewayLinkStatus, string> = {
  linked: "連携済み",
  pending: "連携待ち（Grok Botへ→戻る）",
  disconnected: "未連携",
};

const BINDING_LABEL: Record<BindingStatus, string> = {
  unlinked: "未連携",
  linked: "連携済み",
  degraded: "劣化",
  needs_reauth: "要再連携",
  revoked: "取消済み",
};

function bindingChip(status: BindingStatus): string {
  if (status === "linked") return "chip chip-ok";
  if (status === "needs_reauth" || status === "degraded") return "chip chip-warn";
  if (status === "revoked") return "chip chip-danger";
  return "chip";
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  } catch {
    return iso;
  }
}

type BindingRow = {
  employeeId: string;
  displayName: string;
  roleLabel: string;
  binding: EmployeeBinding;
};

export function IntegrationsClient({
  initialStatus,
  initialMode,
  bindingRows = [],
}: {
  initialStatus: GatewayLinkStatus;
  initialMode: IntegrationMode;
  bindingRows?: BindingRow[];
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

  const rows = Array.isArray(bindingRows) ? bindingRows : [];

  return (
    <div className="space-y-4">
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

      <section className="surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">AI社員バインディング（組織）</h2>
            <p className="mt-1 text-xs muted leading-relaxed">
              Managed: lastSuccessAt と status を監視。切断は黙って消さない。
            </p>
          </div>
          <span className="chip chip-warn text-[11px]">
            切断は黙って消さない
          </span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] muted border-b border-[var(--border-soft)]">
                <th className="pb-2 font-normal">AI社員</th>
                <th className="pb-2 font-normal">status</th>
                <th className="pb-2 font-normal">agent</th>
                <th className="pb-2 font-normal">gen</th>
                <th className="pb-2 font-normal">lastSuccessAt</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-xs faint">
                    まだ AI社員がいません
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr
                  key={row.employeeId}
                  className="border-b border-[var(--border-soft)] last:border-0"
                >
                  <td className="py-2.5 pr-3">
                    <Link
                      href={`/app/employees/${row.employeeId}`}
                      className="hover:underline"
                    >
                      {row.displayName}
                    </Link>
                    <div className="text-[11px] faint">{row.roleLabel}</div>
                    <div className="font-mono text-[10px] faint">
                      {row.employeeId}
                    </div>
                  </td>
                  <td className="py-2.5">
                    <span className={bindingChip(row.binding.status)}>
                      {BINDING_LABEL[row.binding.status]}
                    </span>
                  </td>
                  <td className="py-2.5 font-mono text-[11px]">
                    {row.binding.grokBotAgentId ?? "—"}
                  </td>
                  <td className="py-2.5 tabular-nums">
                    {row.binding.credentialGeneration}
                  </td>
                  <td className="py-2.5 text-xs">
                    {formatTs(row.binding.lastSuccessAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
