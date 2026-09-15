"use client";

import { useState, useEffect, useCallback } from "react";
import type { ApprovalRequest } from "@/lib/types";

type ProxyApprovalMandate = "setup" | "support";

const MANDATE_OPTIONS: { value: ProxyApprovalMandate; label: string }[] = [
  { value: "setup", label: "セットアップ代行" },
  { value: "support", label: "サポート対応" },
];

function formatDate(value: string | null, includeTime = false): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}

function RiskBadge({ risk }: { risk: string }) {
  const tone =
    risk === "high" ? "chip-error" : risk === "medium" ? "chip-warn" : "chip";
  return <span className={`chip ${tone} text-[10px]`}>{risk}</span>;
}

type ApprovalItemProps = {
  approval: ApprovalRequest;
  onResolve: (id: string, decision: "approved" | "rejected", mandate: ProxyApprovalMandate, note: string) => Promise<void>;
  isResolving: boolean;
};

function ApprovalItem({ approval, onResolve, isResolving }: ApprovalItemProps) {
  const [mandate, setMandate] = useState<ProxyApprovalMandate>("setup");
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"approved" | "rejected" | null>(null);

  const handleResolve = async (decision: "approved" | "rejected") => {
    if (!confirmAction) {
      setConfirmAction(decision);
      return;
    }
    await onResolve(approval.id, decision, mandate, note);
    setConfirmAction(null);
    setNote("");
  };

  const cancelConfirm = () => setConfirmAction(null);

  return (
    <li className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold truncate">{approval.title}</p>
            <RiskBadge risk={approval.risk} />
            {approval.tool && (
              <span className="font-mono text-[10px] text-[var(--accent-strong)]">{approval.tool}</span>
            )}
          </div>
          <p className="mt-1 text-xs muted truncate">{approval.purpose}</p>
          <p className="mt-1 text-[11px] faint">
            作成: {formatDate(approval.createdAt, true)}
            {approval.employeeId && <span className="ml-2">社員ID: {approval.employeeId.slice(0, 8)}…</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="btn btn-ghost text-xs shrink-0"
        >
          {expanded ? "閉じる" : "詳細"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-[var(--border-soft)] pt-3">
          <div className="mb-3">
            <p className="text-xs font-semibold mb-1">概要</p>
            <p className="text-sm whitespace-pre-wrap bg-[var(--surface-alt)] p-2 rounded text-[var(--fg)]">
              {approval.summary}
            </p>
          </div>

          {confirmAction ? (
            <div className="mt-3 p-3 rounded bg-[var(--surface-alt)] border border-[var(--border)]">
              <p className="text-sm font-semibold mb-2">
                {confirmAction === "approved" ? "承認" : "却下"}を確定しますか？
              </p>

              <div className="space-y-2 mb-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    名目 <span className="text-[var(--warn)]">*</span>
                  </label>
                  <select
                    value={mandate}
                    onChange={(e) => setMandate(e.target.value as ProxyApprovalMandate)}
                    className="input w-full"
                    disabled={isResolving}
                  >
                    {MANDATE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1">メモ（任意）</label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="例: Space Tree 初期設定のため"
                    className="input w-full"
                    disabled={isResolving}
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleResolve(confirmAction)}
                  disabled={isResolving}
                  className={`btn flex-1 ${confirmAction === "approved" ? "btn-primary" : "btn-warn"}`}
                >
                  {isResolving ? "処理中…" : confirmAction === "approved" ? "承認を確定" : "却下を確定"}
                </button>
                <button
                  type="button"
                  onClick={cancelConfirm}
                  disabled={isResolving}
                  className="btn btn-ghost"
                >
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => handleResolve("approved")}
                disabled={isResolving}
                className="btn btn-primary flex-1"
              >
                承認
              </button>
              <button
                type="button"
                onClick={() => handleResolve("rejected")}
                disabled={isResolving}
                className="btn btn-warn flex-1"
              >
                却下
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ProxyApprovalPanel({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/approvals`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "fetch_failed");
        return;
      }
      setApprovals(data.approvals || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  const handleResolve = async (
    approvalId: string,
    decision: "approved" | "rejected",
    mandate: ProxyApprovalMandate,
    note: string
  ) => {
    setResolvingId(approvalId);
    setLastResult(null);

    try {
      const res = await fetch(
        `/api/admin/organizations/${orgId}/approvals/${approvalId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, mandate, note }),
        }
      );
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setLastResult({ ok: false, message: data.message || data.error || "resolve_failed" });
        return;
      }

      setLastResult({
        ok: true,
        message: `${decision === "approved" ? "承認" : "却下"}しました`,
      });
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    } catch (err) {
      setLastResult({
        ok: false,
        message: err instanceof Error ? err.message : "network_error",
      });
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <section className="surface overflow-hidden">
      <header className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-bold">承認待ちチケット（プラットフォーム代行）</h2>
        <p className="mt-1 text-xs faint">
          Super Admin として <span className="font-semibold">{orgName}</span> の承認待ちチケットを処理できます。
          名目（setup / support）と監査メモが必須です。
        </p>
      </header>

      {lastResult && (
        <div
          className={`px-4 py-2 text-sm ${
            lastResult.ok
              ? "bg-[var(--success-bg,#dcfce7)] text-[var(--success,#166534)]"
              : "bg-[var(--warn-bg,#fef3c7)] text-[var(--warn,#92400e)]"
          }`}
        >
          {lastResult.message}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-sm muted">読み込み中…</div>
      ) : error ? (
        <div className="p-8 text-center text-sm text-[var(--warn)]">
          エラー: {error}
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              fetchApprovals();
            }}
            className="ml-2 underline"
          >
            再読み込み
          </button>
        </div>
      ) : approvals.length === 0 ? (
        <div className="p-8 text-center text-sm muted">承認待ちのチケットはありません。</div>
      ) : (
        <ul className="divide-y divide-[var(--border-soft)]">
          {approvals.map((approval) => (
            <ApprovalItem
              key={approval.id}
              approval={approval}
              onResolve={handleResolve}
              isResolving={resolvingId === approval.id}
            />
          ))}
        </ul>
      )}

      <footer className="px-4 py-3 border-t border-[var(--border)] text-[10px] faint">
        ※ 代行承認/却下は監査ログに「プラットフォーム代行」として記録されます。テナントオーナーの操作とは明確に区別されます。
      </footer>
    </section>
  );
}
