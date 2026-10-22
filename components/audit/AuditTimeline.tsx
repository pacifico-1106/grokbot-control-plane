"use client";

import { useEffect, useState } from "react";
import type { AuditRowView } from "@/lib/audit/types";
import { AUDIT_RESULT_LABEL_JA } from "@/lib/audit/result";

const ACTOR_KIND_JA = {
  ai: "AI",
  human: "人",
  system: "システム",
  unknown: "不明",
} as const;

function resultChipClass(kind: AuditRowView["result"]["kind"]): string {
  if (kind === "success") return "chip chip-ok";
  if (kind === "pending") return "chip chip-warn";
  if (kind === "failure" || kind === "denied") return "chip chip-danger";
  return "chip";
}

function approvalLabel(row: AuditRowView): string {
  const { needed, status, approverName } = row.approval;
  if (needed === false) return "承認不要";
  if (status === "pending") return "承認待ち";
  if (status === "approved") return approverName ? `承認済み · ${approverName}` : "承認済み";
  if (status === "rejected") return "却下";
  if (status === "expired") return "承認期限切れ";
  if (status === "revision_requested") return "修正依頼";
  if (needed === null && status === "unknown") return "承認: 不明";
  return "承認: 不明";
}

function SafeMetaList({ row }: { row: AuditRowView }) {
  const items: Array<{ k: string; v: string }> = [];
  if (row.safeMeta.purpose) items.push({ k: "目的", v: row.safeMeta.purpose });
  if (row.safeMeta.jobId) items.push({ k: "jobId", v: row.safeMeta.jobId });
  if (row.safeMeta.risk) items.push({ k: "リスク", v: row.safeMeta.risk });
  if (row.safeMeta.informationClass) items.push({ k: "情報区分", v: row.safeMeta.informationClass });
  if (row.safeMeta.audience) items.push({ k: "相手", v: row.safeMeta.audience });
  if (row.safeMeta.approvalIdPrefix) items.push({ k: "承認票", v: row.safeMeta.approvalIdPrefix });
  if (items.length === 0) return null;
  return (
    <dl className="mt-3 grid gap-1 text-xs">
      {items.map((item) => (
        <div key={item.k} className="flex flex-wrap gap-x-2">
          <dt className="faint">{item.k}</dt>
          <dd className="break-words">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditTimeline({ rows }: { rows: AuditRowView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative space-y-0 pl-3 sm:pl-4 border-l border-[var(--border)] min-w-0">
      {rows.map((row) => {
        const open = openId === row.id;
        return (
          <article key={row.id} className="relative pb-6">
            <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--text-faint)] ring-4 ring-[var(--bg)]" />
            <div className="surface p-4 ml-2 min-w-0">
              <button
                type="button"
                className="w-full text-left"
                aria-expanded={open}
                aria-controls={`audit-detail-${row.id}`}
                onClick={() => setOpenId(open ? null : row.id)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">{row.action.labelJa}</span>
                  <span className={resultChipClass(row.result.kind)}>
                    {AUDIT_RESULT_LABEL_JA[row.result.kind]}
                  </span>
                  <span className="text-xs faint ml-auto">
                    {row.createdAtJst}
                  </span>
                </div>
                <p className="mt-2 text-xs muted flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-words">
                  <span className="chip text-[10px]">{ACTOR_KIND_JA[row.actor.kind]}</span>
                  <span>{row.actor.name}</span>
                  {row.actor.emailMasked ? (
                    <span className="font-mono faint">{row.actor.emailMasked}</span>
                  ) : null}
                </p>
                <p className="mt-3 text-sm leading-relaxed break-words">{row.summary}</p>
                {row.target.kind !== "none" && row.target.labelJa !== "—" ? (
                  <p className="mt-2 text-xs faint">対象 {row.target.labelJa}</p>
                ) : null}
                {row.result.reasonJa ? (
                  <p className="mt-2 text-xs muted">{row.result.reasonJa}</p>
                ) : null}
                <p className="mt-2 text-xs faint">{approvalLabel(row)}</p>
              </button>
              {open ? (
                <div
                  id={`audit-detail-${row.id}`}
                  className="mt-4 border-t border-[var(--border)] pt-3 text-sm"
                >
                  <p className="text-xs faint">詳細（本文・生データは出しません）</p>
                  <p className="mt-2 text-xs muted">
                    {row.createdAtJstPrecise}
                  </p>
                  <p className="mt-2">
                    <span className="faint text-xs">操作</span>{" "}
                    {row.action.labelJa}
                    <span className="ml-2 font-mono faint text-[11px]">{row.action.id}</span>
                  </p>
                  <p className="mt-2">
                    <span className="faint text-xs">実行者</span>{" "}
                    {ACTOR_KIND_JA[row.actor.kind]} · {row.actor.name}
                    {row.actor.emailMasked ? ` · ${row.actor.emailMasked}` : ""}
                    {row.actor.employeeId ? (
                      <span className="ml-2 font-mono faint text-[11px]">
                        {row.actor.employeeId.slice(0, 8)}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-2">
                    <span className="faint text-xs">対象</span> {row.target.labelJa}
                    {row.target.rawId ? (
                      <span className="ml-2 font-mono faint text-[11px]">{row.target.rawId}</span>
                    ) : null}
                  </p>
                  <p className="mt-2 leading-relaxed break-words">{row.summaryDetail}</p>
                  <p className="mt-2 text-xs">
                    {AUDIT_RESULT_LABEL_JA[row.result.kind]}
                    {row.result.reasonJa ? ` · ${row.result.reasonJa}` : ""}
                  </p>
                  <p className="mt-2 text-xs">{approvalLabel(row)}</p>
                  <SafeMetaList row={row} />
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
