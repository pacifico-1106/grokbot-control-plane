"use client";

import { useState } from "react";

export function TrialExtensionForm({
  orgId,
  orgName,
  currentTrialEndsAt,
  subscriptionStatus,
}: {
  orgId: string;
  orgName: string;
  currentTrialEndsAt: string | null;
  subscriptionStatus: string;
}) {
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canExtend = subscriptionStatus === "trialing" || subscriptionStatus === "expired";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDate || loading) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/admin/trial-extension", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          newTrialEndsAt: newDate,
          reason,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "extend_trial_failed");
        return;
      }

      setSuccess(true);
      setNewDate("");
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setLoading(false);
    }
  };

  if (!canExtend) {
    return (
      <div className="text-sm muted">
        トライアル延長は trialing/expired ステータスの組織のみ可能です。
        <br />
        現在のステータス: {subscriptionStatus}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="text-sm">
        <span className="font-semibold">{orgName}</span> のトライアル期限を延長します。
        <br />
        <span className="text-xs faint">
          現在の期限: {currentTrialEndsAt ? new Date(currentTrialEndsAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未設定"}
        </span>
      </div>

      <div>
        <label htmlFor="newDate" className="block text-xs font-semibold mb-1">
          新しい期限日 (JST)
        </label>
        <input
          id="newDate"
          type="datetime-local"
          value={newDate}
          onChange={(e) => setNewDate(e.target.value)}
          required
          min={new Date().toISOString().slice(0, 16)}
          className="input w-full"
        />
      </div>

      <div>
        <label htmlFor="reason" className="block text-xs font-semibold mb-1">
          理由（監査ログに記録）
        </label>
        <input
          id="reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例: CS対応のため2週間延長"
          className="input w-full"
        />
      </div>

      {error && (
        <div className="text-xs text-[var(--warn,#c9a227)]">
          エラー: {error}
        </div>
      )}

      {success && (
        <div className="text-xs text-[var(--success,#22c55e)]">
          トライアル期限を延長しました。ページを再読み込みしてください。
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !newDate}
        className="btn btn-primary w-full"
      >
        {loading ? "処理中…" : "延長する"}
      </button>

      <p className="text-[10px] faint">
        ※ テナントの課金ゲートは解除されません。延長後も通常の課金フローは適用されます。
      </p>
    </form>
  );
}
