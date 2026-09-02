"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function EmployeeRevokeButton({
  employeeId,
  displayName,
}: {
  employeeId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function revoke() {
    if (!window.confirm(`${displayName} の社員証を失効します。よろしいですか？`)) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/terminate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || "失効に失敗しました");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "失効に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="relative z-[1]">
      <button
        type="button"
        className="text-xs text-[var(--danger)] underline underline-offset-2 min-h-[44px]"
        disabled={busy}
        onClick={() => void revoke()}
      >
        {busy ? "処理中…" : "失効"}
      </button>
      {message ? <span className="ml-2 text-[11px] muted">{message}</span> : null}
    </span>
  );
}
