"use client";

/**
 * /admin: emergency stop. An owner of this org is stamped as a tenant web hold
 * (releasable on /app). Anyone else is ops_console; release of that is S4
 * (two ops people), not here.
 */
import { useState } from "react";

export function OpsHoldStopForm({ orgId }: { orgId: string }) {
  const [employeeId, setEmployeeId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function stop(scope: "employee" | "org") {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/holds/stop", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(scope === "org" ? { orgId, scope: "org", reason } : { orgId, employeeId: employeeId.trim(), reason }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string; via?: string };
      setMessage(res.ok
        ? (json.via === "web"
          ? "停止しました（解除はダッシュボードで別のオーナーが承認します）"
          : "停止しました（解除は S4 の二人承認で行います）")
        : json.message || json.error || "失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface p-4 space-y-2">
      <h2 className="text-sm font-bold">緊急停止（運営）</h2>
      <p className="text-xs muted leading-relaxed">この組織のオーナーとして押すとテナント停止になります（/app の二人承認で解除）。オーナーではない運営アカウントから押した場合のみ運営停止になり、テナントからは解除できません。</p>
      <input className="input w-full" placeholder="AI社員ID（組織全体なら空のまま下のボタン）" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
      <input className="input w-full" placeholder="理由" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <button type="button" className="btn btn-danger" disabled={busy || !employeeId.trim()} onClick={() => stop("employee")}>このAI社員を停止</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => stop("org")}>組織全体を停止</button>
      </div>
      {message ? <p className="text-xs" role="status">{message}</p> : null}
    </section>
  );
}
