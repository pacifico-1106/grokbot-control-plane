"use client";

/**
 * S3 緊急停止 panel (employee or org). Stop is one press. Release is two steps
 * (request → another owner / designated admin approves), each behind a fresh
 * login (5 minutes). /app/approvals の『解除を承認』も同じ
 * /api/holds/release/approve を呼ぶ。Inbox buttons can only stop and link here.
 *
 * Display is fail-closed: an unreadable status never shows the stop button.
 * /app must pass `initial` from the server (orgs.hold_state); a client GET
 * that says "none" must not overwrite a held pointer (CDN / stale GET).
 */
import { useCallback, useEffect, useState } from "react";
import { approvalDecideErrorJa } from "@/lib/approvals/hold-release-web";
import {
  HOLD_DISPLAY_UNREADABLE_JA,
  holdDisplayMode,
  mergeHoldStatus,
  type HoldPanelStatus,
} from "@/lib/safety/hold-display";

const KIND_JA: Record<string, string> = { stopped: "緊急停止中", leave: "休職中", quarantined: "隔離中（自動検知）" };

export function HoldPanel({
  employeeId, scope = "employee", initial = null,
}: {
  employeeId?: string;
  scope?: "employee" | "org";
  initial?: HoldPanelStatus | null;
}) {
  const [status, setStatus] = useState<HoldPanelStatus | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/holds/status", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope === "org" ? { scope: "org" } : { employeeId: employeeId ?? "" }),
      });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const next = (await res.json()) as HoldPanelStatus;
      setLoadFailed(false);
      setStatus((prev) => mergeHoldStatus(prev, next));
    } catch {
      setLoadFailed(true);
    }
  }, [employeeId, scope]);
  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) setMessage(approvalDecideErrorJa(json));
      else setMessage(done);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const mode = holdDisplayMode(status, scope, loadFailed && !status);
  if (mode === "loading" || mode === "hidden") return null;
  const target = scope === "org" ? { scope: "org" } : { employeeId };
  const h = status?.hold ?? null;
  return (
    <section id="hold" className="surface p-5 mt-4 space-y-3 ring-1 ring-[color-mix(in_oklab,var(--danger)_52%,transparent)]">
      <h2 className="text-sm font-medium">{scope === "org" ? "緊急停止（組織全体）" : "緊急停止"}</h2>
      {mode === "error" ? <p className="text-sm" role="alert">{HOLD_DISPLAY_UNREADABLE_JA}</p> : null}
      {mode === "stop" ? (
        <>
          <p className="text-xs muted leading-relaxed">押すとすぐ止まります（送信・実行・起動のすべて）。解除は別の人の承認が必要です。</p>
          <input className="input w-full" placeholder="理由（任意・社内向け）" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => post("/api/holds/stop", { ...target, reason }, "停止しました")}>緊急停止</button>
        </>
      ) : null}
      {mode === "held" && h ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{KIND_JA[h.kind] ?? h.kind}{h.startedAt ? `（${new Date(h.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST）` : ""}</p>
          {h.opsHold ? <p className="text-xs muted">運営が止めた停止です。解除は運営のみが行えます。</p> : !h.releaseRequested ? (
            <>
              <input className="input w-full" placeholder="解除の理由（必須）" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => post("/api/holds/release/request", { holdId: h.id, reason }, "解除を申請しました。別の人の承認を待っています。")}>解除を申請</button>
            </>
          ) : h.releaseRequestedBy === status?.me ? (
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
