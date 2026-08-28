"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Employee } from "@/lib/types";

const CONFIRM_PHRASE = "契約終了";

export function EmployeeTerminateForm({ employee }: { employee: Employee }) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (employee.status === "suspended") {
    return (
      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">契約終了</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          契約終了済み。社員証は失効。AI社員番号と監査は残っています。
        </p>
      </section>
    );
  }

  async function terminate() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/employees/${employee.id}/terminate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.message || body.error || "契約終了に失敗しました");
      }
      setMessage("契約を終了しました");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "契約終了に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = confirmText.trim() === CONFIRM_PHRASE && !busy;

  return (
    <section
      className="surface p-5 mt-4 space-y-3 ring-1 ring-[color-mix(in_oklab,var(--danger)_52%,transparent)]"
    >
      <h2 className="text-sm font-medium">契約終了</h2>
      <p className="text-sm leading-relaxed">
        名簿からは消しません。Gateway は閉じます。
      </p>
      <p className="text-xs muted leading-relaxed">
        社員証を失効し、このAI社員を停止します。AI社員番号と監査ログは残ります。再開はこの画面ではできません。
      </p>
      <label className="block text-sm">
        <span className="muted">確認のため「{CONFIRM_PHRASE}」と入力</span>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          placeholder={CONFIRM_PHRASE}
          disabled={busy}
          autoComplete="off"
        />
      </label>
      <button
        type="button"
        className="btn text-sm w-full sm:w-auto"
        style={{
          background: "color-mix(in oklab, var(--danger) 16%, transparent)",
          borderColor: "color-mix(in oklab, var(--danger) 52%, var(--border))",
          color: "var(--danger)",
        }}
        disabled={!canSubmit}
        onClick={() => void terminate()}
      >
        {busy ? "処理中…" : "契約終了"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </section>
  );
}
