"use client";

/**
 * S3 緊急停止 panel (employee or org). Stop is one press. Release is two steps on THIS
 * screen only (request → another owner / designated admin approves), each behind a fresh
 * login (5 minutes). Inbox buttons can only stop and link here.
 */
import { useCallback, useEffect, useState } from "react";

type Status = {
  ok: boolean;
  enabled: boolean;
  orgEnabled: boolean;
  state: "none" | "held" | "unknown";
  me: string;
  hold: null | { id: string; kind: string; startedVia: string; startedAt: string; opsHold: boolean; releaseRequestedBy: string | null; releaseRequested: boolean };
};

const KIND_JA: Record<string, string> = { stopped: "緊急停止中", leave: "休職中", quarantined: "隔離中（自動検知）" };

export function HoldPanel({ employeeId, scope = "employee" }: { employeeId?: string; scope?: "employee" | "org" }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const query = scope === "org" ? "scope=org" : `employeeId=${encodeURIComponent(employeeId ?? "")}`;

  const load = useCallback(async () => {
    const res = await fetch(`/api/holds/status?${query}`, { cache: "no-store" });
    setStatus(res.ok ? ((await res.json()) as Status) : null);
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        if (json.error === "fresh_login_required") setMessage("解除にはログインし直してください（5分以内のログインが必要です）。");
        else setMessage(json.message || json.error || "失敗しました");
      } else setMessage(done);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!status || !status.enabled || (scope === "org" && !status.orgEnabled)) return null;
  const target = scope === "org" ? { scope: "org" } : { employeeId };
  const h = status.hold;
  return (
    <section id="hold" className="surface p-5 mt-4 space-y-3 ring-1 ring-[color-mix(in_oklab,var(--danger)_52%,transparent)]">
      <h2 className="text-sm font-medium">{scope === "org" ? "緊急停止（組織全体）" : "緊急停止"}</h2>
      {status.state === "unknown" ? <p className="text-sm">停止状態を確認できません（安全のため止まっている扱いです）。</p> : null}
      {status.state === "none" ? (
        <>
          <p className="text-xs muted leading-relaxed">押すとすぐ止まります（送信・実行・起動のすべて）。解除は別の人の承認が必要です。</p>
          <input className="input w-full" placeholder="理由（任意・社内向け）" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => post("/api/holds/stop", { ...target, reason }, "停止しました")}>緊急停止</button>
        </>
      ) : null}
      {h ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{KIND_JA[h.kind] ?? h.kind}（{new Date(h.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST）</p>
          {h.opsHold ? <p className="text-xs muted">運営が止めた停止です。解除は運営のみが行えます。</p> : !h.releaseRequested ? (
            <>
              <input className="input w-full" placeholder="解除の理由（必須）" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => post("/api/holds/release/request", { holdId: h.id, reason }, "解除を申請しました。別の人の承認を待っています。")}>解除を申請</button>
            </>
          ) : h.releaseRequestedBy === status.me ? (
            <p className="text-xs muted">解除を申請済みです。別のオーナーか指定管理者の承認を待っています（一人オーナーの組織は本人が承認できます）。</p>
          ) : null}
          {h.releaseRequested && !h.opsHold ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => post("/api/holds/release/approve", { holdId: h.id }, "解除しました")}>解除を承認</button>
          ) : null}
        </div>
      ) : null}
      {message ? <p className="text-xs" role="status">{message}</p> : null}
    </section>
  );
}
