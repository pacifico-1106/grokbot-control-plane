"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { channelErrorMessage } from "@/lib/notify/channel-errors";
import type { ApprovalRequest, Employee } from "@/lib/types";

function pollUrlFor(a: ApprovalRequest): string {
  if (typeof window !== "undefined" && a.pollPath) {
    return `${window.location.origin}${a.pollPath}`;
  }
  return a.pollPath || "";
}

export function ApprovalsClient({
  initial,
  employees,
  demoDurable = true,
  demoStore = null,
}: {
  initial: ApprovalRequest[];
  employees: Employee[];
  /** DEMO: false when only in-memory (Vercel isolate split risk). */
  demoDurable?: boolean;
  demoStore?: "upstash" | "github" | "http" | "memory" | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [storeLabel, setStoreLabel] = useState(demoStore);
  const [durable, setDurable] = useState(demoDurable);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as {
        approvals?: ApprovalRequest[];
        durable?: boolean;
        demoStore?: "upstash" | "github" | "http" | "memory" | null;
      };
      if (Array.isArray(body.approvals)) setRows(body.approvals);
      if (typeof body.durable === "boolean") setDurable(body.durable);
      if (body.demoStore != null) setStoreLabel(body.demoStore);
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  useEffect(() => {
    setRows(initial);
  }, [initial]);

  useEffect(() => {
    void refreshList();
    const t = setInterval(() => {
      void refreshList();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshList]);

  async function decide(id: string, action: "approve" | "reject") {
    setPendingId(id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/approvals/${id}/${action}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "failed");
      setRows((cur) =>
        cur.map((r) =>
          r.id === id
            ? {
                ...r,
                status: action === "approve" ? "approved" : "rejected",
                resolvedAt: new Date().toISOString(),
              }
            : r
        )
      );
      await refreshList();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setPendingId(null);
    }
  }

  async function resendCard(id: string) {
    setPendingId(id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/approvals/${id}/notify`, { method: "POST" });
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        results?: Array<{ ok?: boolean; skipped?: boolean; error?: string }>;
      };
      if (!res.ok) {
        throw new Error(channelErrorMessage(body, "再送に失敗しました"));
      }
      const results = Array.isArray(body.results) ? body.results : [];
      const failed = results.find((row) => !row.ok && !row.skipped);
      if (failed) {
        setError(channelErrorMessage(failed, "再送に失敗しました"));
        return;
      }
      if (results.length === 0) {
        setError("送信先の承認インボックスがありません");
        return;
      }
      setNotice("カードを再送しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "再送に失敗しました");
    } finally {
      setPendingId(null);
    }
  }

  async function copyPoll(a: ApprovalRequest) {
    const url = pollUrlFor(a);
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopiedId(a.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  async function requestRevision(id: string) {
    const note = revisionNote.trim();
    if (!note) {
      setError("修正内容を入力してください");
      return;
    }
    setPendingId(id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/approvals/${id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "failed");
      setRevisionId(null);
      setRevisionNote("");
      await refreshList();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setPendingId(null);
    }
  }

  const pending = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4">
      <p className="text-xs muted leading-relaxed rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2">
        Bot は署名付き{" "}
        <Link href="/app/guides/approval-loop" className="underline underline-offset-2">
          ステータス poll URL
        </Link>{" "}
        を正本として待ちます（Partner webhook が来るまで必須）。メール通知は副次です。
      </p>

      {!durable ? (
        <p className="text-xs leading-relaxed rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-950 dark:text-amber-100">
          DEMO: 承認ストアがインメモリです（store={storeLabel || "memory"}）。
          Vercel の別インスタンスで Gateway が作ったチケットが一覧に出ない／Bot の
          poll が承認を見ないことがあります。Upstash Redis（または Vercel KV）の{" "}
          <code className="text-[10px]">UPSTASH_REDIS_REST_URL</code> +{" "}
          <code className="text-[10px]">TOKEN</code>、または{" "}
          <code className="text-[10px]">DEMO_APPROVALS_GITHUB_TOKEN</code>{" "}
          を Vercel env に設定して再デプロイしてください。
        </p>
      ) : storeLabel && storeLabel !== "memory" ? (
        <p className="text-[10px] faint">
          DEMO 承認ストア: {storeLabel}（インスタンス横断）
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : null}
      {notice ? (
        <p className="text-sm text-[var(--ok)]">{notice}</p>
      ) : null}

      {pending.length === 0 ? (
        <section className="surface p-8 text-center">
          <p className="text-sm font-medium">要対応はありません</p>
          <p className="mt-2 text-sm muted">
            高リスク操作やポリシー該当の操作が来ると、ここに並びます。
          </p>
        </section>
      ) : (
        <div className="surface overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap items-center gap-2">
            <span className="chip chip-warn">要対応 {pending.length}</span>
            <span className="text-xs faint">承認されるまで実行しません</span>
          </div>
          <ul className="divide-y divide-[var(--border-soft)]">
            {pending.map((a) => {
              const emp = employees.find((e) => e.id === a.employeeId);
              return (
                <li
                  key={a.id}
                  className="px-4 py-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`chip ${
                          a.risk === "high"
                            ? "chip-danger"
                            : a.risk === "medium"
                              ? "chip-warn"
                              : "chip-ok"
                        }`}
                      >
                        {a.risk === "high"
                          ? "高"
                          : a.risk === "medium"
                            ? "中"
                            : a.risk === "low"
                              ? "低"
                              : a.risk}
                      </span>
                      {a.tool ? (
                        <span className="chip text-[11px]">{a.tool}</span>
                      ) : null}
                      <span className="text-xs faint">{a.purpose}</span>
                      <span className="text-xs muted">
                        {emp?.displayName ?? a.employeeId}
                      </span>
                    </div>
                    <h3 className="mt-2 text-sm font-medium leading-snug break-words">
                      {a.title || "承認依頼"}
                    </h3>
                    <pre className="mt-2 text-xs muted leading-relaxed whitespace-pre-wrap break-words font-sans">
                      {a.summary}
                    </pre>
                    <p className="mt-2 text-xs faint flex flex-wrap gap-x-3 gap-y-1">
                      <span>
                        {new Date(a.createdAt).toLocaleString("ja-JP", {
                          timeZone: "Asia/Tokyo",
                        })}{" "}
                        JST
                      </span>
                      {a.jobId ? <span>job: {a.jobId}</span> : null}
                      <span className="font-mono">id: {a.id}</span>
                    </p>
                    {a.pollPath ? (
                      <div className="mt-3 flex flex-col sm:flex-row flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-ghost text-xs min-h-[44px] w-full sm:w-auto"
                          onClick={() => void copyPoll(a)}
                        >
                          {copiedId === a.id
                            ? "poll URL をコピーしました"
                            : "デモ用 poll URL をコピー"}
                        </button>
                        <code className="text-[10px] faint break-all block sm:max-w-md">
                          {a.pollPath}
                        </code>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col sm:flex-row flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      className="btn btn-ghost text-sm w-full sm:w-auto min-h-[44px]"
                      disabled={pendingId === a.id}
                      onClick={() => void resendCard(a.id)}
                    >
                      カードを再送
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-sm w-full sm:w-auto min-h-[44px]"
                      disabled={pendingId === a.id}
                      onClick={() => {
                        setRevisionId((current) =>
                          current === a.id ? null : a.id
                        );
                        setRevisionNote("");
                      }}
                    >
                      修正依頼
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-sm w-full sm:w-auto min-h-[44px]"
                      disabled={pendingId === a.id}
                      onClick={() => void decide(a.id, "reject")}
                    >
                      却下
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary text-sm w-full sm:w-auto min-h-[44px]"
                      disabled={pendingId === a.id}
                      onClick={() => void decide(a.id, "approve")}
                    >
                      承認
                    </button>
                  </div>
                  {revisionId === a.id ? (
                    <div className="lg:col-span-2 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3">
                      <label className="block text-xs muted" htmlFor={`revision-${a.id}`}>
                        AI社員へ返す具体的な修正指示
                      </label>
                      <textarea
                        id={`revision-${a.id}`}
                        className="mt-2 w-full min-h-24 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                        maxLength={2000}
                        value={revisionNote}
                        onChange={(event) => setRevisionNote(event.target.value)}
                        placeholder="例: 2段落目の金額表記を削除して、同じ jobId で再提出してください"
                      />
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          className="btn btn-primary text-sm min-h-[44px]"
                          disabled={pendingId === a.id || !revisionNote.trim()}
                          onClick={() => void requestRevision(a.id)}
                        >
                          修正を依頼する
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {done.length > 0 ? (
        <section className="surface p-4">
          <h2 className="text-xs muted mb-3">処理済み</h2>
          <ul className="space-y-3">
            {done.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm min-w-0">
                <span
                  className={`chip shrink-0 ${
                    a.status === "approved"
                      ? "chip-ok"
                      : a.status === "revision_requested"
                        ? "chip-warn"
                        : "chip-danger"
                  }`}
                >
                  {a.status === "approved"
                    ? "承認済み"
                    : a.status === "rejected"
                      ? "却下"
                      : a.status === "revision_requested"
                        ? "修正依頼"
                      : a.status}
                </span>
                <div className="min-w-0">
                  <p className="font-medium break-words">{a.title || a.summary}</p>
                  <p className="text-xs muted mt-0.5 break-words">
                    {[a.tool, a.purpose, a.jobId].filter(Boolean).join(" · ")}
                  </p>
                  {a.revisionNote ? (
                    <p className="text-xs mt-1 break-words">
                      修正指示: {a.revisionNote}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
