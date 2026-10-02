"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LP_CSRF_HEADER, isHandoffAwaitingConfirmation, readCsrfCookie } from "@/lib/lp/client-session";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "editing"; status: string }
  | { kind: "done"; message: string }
  | { kind: "cancelled" };

export function HandoffConfirmClient({ handoffId }: { handoffId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [summary, setSummary] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/lp/handoff?id=${encodeURIComponent(handoffId)}`, {
        credentials: "same-origin",
      }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (cancelled) return;
      if (!data || typeof data.summaryDraft !== "string") {
        setState({ kind: "missing" });
        return;
      }
      setSummary(data.summaryDraft);
      setState({ kind: "editing", status: String(data.status ?? "") });
    })();
    return () => {
      cancelled = true;
    };
  }, [handoffId]);

  async function call(method: "PUT" | "DELETE") {
    const token = readCsrfCookie(document.cookie);
    if (!token) {
      setError("セッションが切れました。相談窓口からやり直してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res =
        method === "PUT"
          ? await fetch("/api/lp/handoff", {
              method: "PUT",
              headers: { "Content-Type": "application/json", [LP_CSRF_HEADER]: token },
              credentials: "same-origin",
              body: JSON.stringify({
                handoffId,
                summaryFinal: summary,
                contactEmail: email || undefined,
                contactPhone: phone || undefined,
                contactNotes: notes || undefined,
              }),
            })
          : await fetch(`/api/lp/handoff?id=${encodeURIComponent(handoffId)}`, {
              method: "DELETE",
              headers: { [LP_CSRF_HEADER]: token },
              credentials: "same-origin",
            });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message === "Invalid email format" ? "メールアドレスの形式を確認してください。"
          : data?.message === "Invalid phone format" ? "電話番号の形式を確認してください。"
          : "処理できませんでした。すでに確定または取消済みの可能性があります。");
        return;
      }
      setState(
        method === "PUT"
          ? { kind: "done", message: String(data?.message ?? "ご依頼を受け付けました。") }
          : { kind: "cancelled" }
      );
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return <p className="mt-6 text-sm faint">読み込み中…</p>;
  if (state.kind === "missing")
    return (
      <p className="mt-6 text-sm" data-testid="handoff-missing">
        この相談は見つかりませんでした。相談を始めたブラウザで開いてください。{" "}
        <Link href="/lp/ai-employee" className="underline">AI社員のページへ戻る</Link>
      </p>
    );
  if (state.kind === "done")
    return <p className="mt-6 text-sm" data-testid="handoff-done">{state.message}</p>;
  if (state.kind === "cancelled")
    return <p className="mt-6 text-sm" data-testid="handoff-cancelled">相談の依頼を取り消しました。担当者には共有されていません。</p>;

  // Rows are created as "pending_confirmation" (lib/lp/handoffs.ts); comparing with "pending"
  // made every new handoff look already processed and disabled the confirm form.
  const pending = isHandoffAwaitingConfirmation(state.status);
  const canConfirm = pending && summary.trim().length > 0 && summary.length <= 2000 && (email || phone);

  return (
    <form
      className="mt-6 flex flex-col gap-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (canConfirm) void call("PUT");
      }}
    >
      {!pending && <p className="text-xs faint">この相談はすでに処理済みです（{state.status}）。</p>}
      <label className="flex flex-col gap-1">
        <span className="font-medium">担当者に共有する内容</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={2000}
          rows={8}
          disabled={!pending}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3"
        />
        <span className="text-xs faint">{summary.length}/2000　パスワードやカード番号は書かないでください。</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">メールアドレス</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} disabled={!pending}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">電話番号（任意）</span>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} disabled={!pending}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">連絡の希望（任意）</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} disabled={!pending}
          placeholder="例：平日午後が希望"
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2" />
      </label>
      <p className="text-xs faint">メールアドレスか電話番号のどちらかが必要です。確定すると、この内容が担当者に共有されます。</p>
      {error && <p className="text-xs text-red-500" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={!canConfirm || busy} data-testid="handoff-confirm">
          この内容で相談を依頼する
        </button>
        <button type="button" className="btn" disabled={!pending || busy} onClick={() => void call("DELETE")}>
          取り消す
        </button>
      </div>
    </form>
  );
}
