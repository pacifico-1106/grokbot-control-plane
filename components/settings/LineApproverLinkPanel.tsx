"use client";

import { useCallback, useEffect, useState } from "react";

type Status = { pending: { expiresAt: string } | null; linked: string[] };

/**
 * LINE approver self-link (G1/G4). Hidden unless the server flag
 * LINE_APPROVER_LINK_ENABLED is ON (the API answers 404 when OFF).
 * Shows a one-time code to send to the official account in a 1:1 chat, then the
 * verified LINE userId. Nothing is auto-filled into allowed / approver IDs.
 */
export function LineApproverLinkPanel({ channelId }: { channelId: string }) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/settings/line-approver-link?channelId=${encodeURIComponent(channelId)}`, {
      cache: "no-store",
    }).catch(() => null);
    if (!res || !res.ok) {
      setAvailable(false);
      return;
    }
    const json = (await res.json()) as Status;
    setAvailable(true);
    setStatus({ pending: json.pending ?? null, linked: Array.isArray(json.linked) ? json.linked : [] });
    if (!json.pending) setCode(null);
  }, [channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!available) return null;

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/line-approver-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: string; expiresAt?: string; message?: string };
      if (!res.ok || !json.code || !json.expiresAt) {
        setError(json.message || "連携コードを発行できませんでした");
        return;
      }
      setCode({ code: json.code, expiresAt: json.expiresAt });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
      <p className="text-xs font-medium">あなたの LINE を承認者として確認する</p>
      <p className="text-[11px] faint leading-relaxed">
        コードを発行し、この LINE 公式アカウントとの 1:1 トークにそのまま送ってください（15分・1回限り）。
        確認できた LINE ユーザー ID がここに表示されます。許可user ID や承認者 ID への反映は手動です。
      </p>
      {code ? (
        <p className="text-sm">
          連携コード: <span className="font-mono font-semibold">{code.code}</span>
          <span className="text-[11px] faint ml-2">有効期限 {new Date(code.expiresAt).toLocaleTimeString("ja-JP")}</span>
        </p>
      ) : status?.pending ? (
        <p className="text-[11px] faint">発行済みのコードがあります（有効期限 {new Date(status.pending.expiresAt).toLocaleTimeString("ja-JP")}）。表示し直す場合は再発行してください。</p>
      ) : null}
      {status && status.linked.length > 0 ? (
        <p className="text-[11px] break-all">
          確認済み LINE ユーザー ID: <span className="font-mono">{status.linked.join(", ")}</span>
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={() => void issue()}>
          {code || status?.pending ? "コードを再発行" : "連携コードを発行"}
        </button>
        <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={() => void refresh()}>
          状態を確認
        </button>
      </div>
    </div>
  );
}
