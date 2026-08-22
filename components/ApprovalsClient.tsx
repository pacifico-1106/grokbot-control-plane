"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApprovalRequest, Employee } from "@/lib/types";

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

  async function decide(id: string, action: "approve" | "reject") {
    setPendingId(id);
    setError("");
    try {
      const res = await fetch(`/api/approvals/${id}/${action}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "failed");
      setRows((cur) =>
        cur.map((r) => (r.id === id ? { ...r, status: action === "approve" ? "approved" : "rejected" } : r))
      );
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
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <span className="chip chip-warn">要対応 {pending.length}</span>
            <span className="text-xs faint">fail-closed · 未承認は実行されない</span>
          </div>
          <ul className="divide-y divide-[var(--border-soft)]">
            {pending.map((a) => {
              const emp = employees.find((e) => e.id === a.employeeId);
              return (
                <li
                  key={a.id}
                  className="px-4 py-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center"
                >
                  <div>
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
                        {a.risk}
                      </span>
                      <span className="text-xs faint">{a.purpose}</span>
                      <span className="text-xs muted">
                        {emp?.displayName ?? a.employeeId}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-snug">{a.summary}</p>
                    <p className="mt-1 text-xs faint">
                      {new Date(a.createdAt).toLocaleString("ja-JP", {
                        timeZone: "Asia/Tokyo",
                      })}{" "}
                      JST
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      className="btn btn-ghost text-xs px-3 py-1.5"
                      disabled={pendingId === a.id}
                      onClick={() => void decide(a.id, "reject")}
                    >
                      却下
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary text-xs px-3 py-1.5"
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
          <ul className="space-y-2">
            {done.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <span className={`chip ${a.status === "approved" ? "chip-ok" : "chip-danger"}`}>
                  {a.status}
                </span>
                <span className="muted truncate">{a.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
