"use client";

import { useCallback, useEffect, useState } from "react";

type Grant = {
  id: string;
  clientHost: string;
  status: "active" | "revoked";
  grantedByEmail: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—");

/** 「接続中の AI クライアント」: list + revoke (MCP OAuth, rendered only when the flag is ON). */
export function OAuthGrantsPanel({ employeeId }: { employeeId: string }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/employees/${employeeId}/oauth-grants`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "load_failed");
      setGrants(body.grants as Grant[]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "load_failed");
      setGrants([]);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(g: Grant) {
    if (!window.confirm(`${g.clientHost} への接続を取り消しますか？`)) return;
    setBusy(g.id);
    setMessage("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/oauth-grants/${g.id}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "revoke_failed");
      setMessage(`${g.clientHost} への接続を取り消しました`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setBusy(null);
    }
  }

  const active = (grants ?? []).filter((g) => g.status === "active");
  return (
    <section className="surface p-4 md:p-5">
      <h2 className="text-sm font-semibold">接続中の AI クライアント（OAuth）</h2>
      <p className="mt-1 text-xs muted">ChatGPT / Claude などにこの AI 社員の社員証を貸し出している接続です。取り消すと次のリクエストから使えなくなります。</p>
      {grants === null ? (
        <p className="mt-3 text-sm muted">読み込み中…</p>
      ) : active.length === 0 ? (
        <p className="mt-3 text-sm muted">接続はありません。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {active.map((g) => (
            <li key={g.id} className="rounded border p-3 text-sm flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>{g.clientHost}</strong>
                <div className="text-xs muted">
                  許可: {g.grantedByEmail}（{fmt(g.createdAt)}）・最終利用: {fmt(g.lastUsedAt)}・期限: {fmt(g.expiresAt)}
                </div>
              </div>
              <button type="button" className="btn btn-ghost text-xs" disabled={busy !== null} onClick={() => void revoke(g)}>
                取り消す
              </button>
            </li>
          ))}
        </ul>
      )}
      {message ? <p className="mt-2 text-xs" role="status">{message}</p> : null}
    </section>
  );
}
