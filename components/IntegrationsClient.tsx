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
  unlinked: "未接続",
  linked: "接続中",
  degraded: "不安定",
  needs_reauth: "再接続が必要",
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
            「おまかせ導入」か「今の Grok Bot に載せる」かを選べます。
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
                <div className="text-sm">おまかせ導入</div>
                <p className="text-xs muted mt-1">
                  当社が Grok Bot を用意し、Staffpass（制御）につないだ状態でお渡しします。
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
                <div className="text-sm">今の Grok Bot に載せる</div>
                <p className="text-xs muted mt-1">
                  いまお使いのワークスペースを持ち込み。社員証の確認と記録だけをつなぎます。
                </p>
              </div>
            </label>
          </div>
        </section>

        <section className="surface p-5">
          <h2 className="text-sm font-medium">Grok Bot とのつながり</h2>
          <p className="mt-2 text-sm muted">
            流れは「未連携 → 手続き中 → 連携済み」です。
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
          </div>
          <div className="mt-5 flex flex-col sm:flex-row flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary text-sm w-full sm:w-auto"
              disabled={busy || status === "linked"}
              onClick={() => void run("connect")}
            >
              Grok Botへ連携
            </button>
            <button
              type="button"
              className="btn btn-ghost text-sm w-full sm:w-auto"
              disabled={busy || status !== "pending"}
              onClick={() => void run("handshake")}
            >
              戻る（連携完了）
            </button>
            <button
              type="button"
              className="btn btn-ghost text-sm w-full sm:w-auto"
              disabled={busy || status === "disconnected"}
              onClick={() => void run("disconnect")}
            >
              切断
            </button>
          </div>
          {message ? <p className="mt-3 text-xs muted">{message}</p> : null}
          <p className="mt-4 text-xs faint leading-relaxed">
            いまはデモのつなぎ方です。本番では、画面の案内に従って安全につなぎ直します。
          </p>
        </section>
      </div>

      <section className="surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">AI社員の接続状態（組織）</h2>
            <p className="mt-1 text-xs muted leading-relaxed">
              最後にうまく動いた時刻と、いまの状態を見ます。切れても記録は残します。
            </p>
          </div>
          <span className="chip chip-warn text-[11px]">
            切れても記録は残す
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="mt-4 text-xs faint">まだ AI社員がいません</p>
        ) : (
          <>
            <ul className="mt-4 space-y-3 md:hidden">
              {rows.map((row) => (
                <li
                  key={row.employeeId}
                  className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3 space-y-2 min-w-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/app/employees/${row.employeeId}`}
                        className="hover:underline text-sm break-words"
                      >
                        {row.displayName}
                      </Link>
                      <div className="text-[11px] faint break-words">{row.roleLabel}</div>
                    </div>
                    <span className={`${bindingChip(row.binding.status)} shrink-0`}>
                      {BINDING_LABEL[row.binding.status]}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="min-w-0">
                      <dt className="faint">エージェント</dt>
                      <dd className="font-mono break-all">{row.binding.grokBotAgentId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="faint">社員証世代</dt>
                      <dd className="tabular-nums">{row.binding.credentialGeneration}</dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="faint">最後の成功</dt>
                      <dd className="break-words">{formatTs(row.binding.lastSuccessAt)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="mt-4 table-scroll hidden md:block">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-[11px] muted border-b border-[var(--border-soft)]">
                    <th className="pb-2 font-normal">AI社員</th>
                    <th className="pb-2 font-normal">接続状態</th>
                    <th className="pb-2 font-normal">エージェント</th>
                    <th className="pb-2 font-normal">社員証世代</th>
                    <th className="pb-2 font-normal">最後の成功</th>
                  </tr>
                </thead>
                <tbody>
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
          </>
        )}
      </section>
    </div>
  );
}
