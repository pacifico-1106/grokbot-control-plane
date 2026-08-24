"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
}: {
  initial: ApprovalRequest[];
  employees: Employee[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function decide(id: string, action: "approve" | "reject") {
    setPendingId(id);
    setError("");
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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
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

      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
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
                    a.status === "approved" ? "chip-ok" : "chip-danger"
                  }`}
                >
                  {a.status === "approved"
                    ? "承認済み"
                    : a.status === "rejected"
                      ? "却下"
                      : a.status}
                </span>
                <div className="min-w-0">
                  <p className="font-medium break-words">{a.title || a.summary}</p>
                  <p className="text-xs muted mt-0.5 break-words">
                    {[a.tool, a.purpose, a.jobId].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
