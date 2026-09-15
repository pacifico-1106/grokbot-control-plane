"use client";

import { useState } from "react";

export function OrgRenameForm({
  orgId,
  currentName,
}: {
  orgId: string;
  currentName: string;
}) {
  const [newName, setNewName] = useState(currentName);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canRename = newName.trim() && newName.trim() !== currentName;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canRename || loading) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/admin/org-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          newName: newName.trim(),
          reason,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "rename_failed");
        return;
      }

      setSuccess(true);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="text-sm">
        組織の表示名を変更します。
        <br />
        <span className="text-xs faint">
          現在の名称: {currentName}
        </span>
      </div>

      <div>
        <label htmlFor="newName" className="block text-xs font-semibold mb-1">
          新しい組織名
        </label>
        <input
          id="newName"
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          required
          maxLength={200}
          className="input w-full"
        />
        <p className="text-[10px] faint mt-1">最大200文字</p>
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
          placeholder="例: 法人名変更のため"
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
          組織名を変更しました。ページを再読み込みしてください。
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !canRename}
        className="btn btn-primary w-full"
      >
        {loading ? "処理中…" : "名称を変更する"}
      </button>

      <p className="text-[10px] faint">
        ※ この操作は監査ログに記録されます。
      </p>
    </form>
  );
}
