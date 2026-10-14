"use client";

import { useState } from "react";

export function EmployeeLineLinkCodeForm({
  employeeId,
  canIssue,
  disabled,
}: {
  employeeId: string;
  canIssue: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [display, setDisplay] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");

  if (!canIssue) return null;

  async function issue() {
    setBusy(true);
    setMessage("");
    setDisplay("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/comm-link-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        display?: string;
        expiresAt?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.message || body.error || "発行に失敗しました");
      setDisplay(body.display || "");
      setExpiresAt(body.expiresAt || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "発行に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs muted leading-relaxed">
        この社員の LINE 公式アカウントに送る 1 回限りの連携コードです。コードを送った人が社内メンバーとして紐付きます。本文はログに残りません。
      </p>
      <button
        type="button"
        className="text-xs underline underline-offset-2 min-h-[44px]"
        disabled={busy || disabled}
        onClick={() => void issue()}
      >
        {busy ? "発行中…" : "連携コードを発行"}
      </button>
      {display ? (
        <p className="text-sm font-mono">
          {display}
          {expiresAt ? <span className="ml-2 text-xs muted">有効期限 {new Date(expiresAt).toLocaleString("ja-JP")}</span> : null}
        </p>
      ) : null}
      {message ? <p className="text-xs text-[var(--danger)]">{message}</p> : null}
    </div>
  );
}
