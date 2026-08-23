"use client";

import { useMemo, useState } from "react";
import {
  ACTION_TYPE_LABEL,
  filterEmployeeActions,
  type ActionLogFilter,
  type EmployeeActionEvent,
  type EmployeeActionType,
} from "@/lib/employee-actions-demo";

const FILTERS: { id: ActionLogFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "success", label: "成功" },
  { id: "fail", label: "失敗" },
  { id: "approval", label: "承認関連" },
];

function typeChipClass(t: EmployeeActionType, success: boolean): string {
  if (t === "deny" || !success) return "chip chip-danger";
  if (t === "approval") return "chip chip-warn";
  if (t === "health") return success ? "chip chip-ok" : "chip chip-danger";
  return "chip chip-ok";
}

function formatTs(iso: string): string {
  try {
    return (
      new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST"
    );
  } catch {
    return iso;
  }
}

export function EmployeeActionLog({
  events,
  compact = false,
  title = "アクションログ",
}: {
  events: EmployeeActionEvent[];
  compact?: boolean;
  title?: string;
}) {
  const [filter, setFilter] = useState<ActionLogFilter>("all");
  const filtered = useMemo(
    () => filterEmployeeActions(events, filter),
    [events, filter]
  );
  const shown = compact ? filtered.slice(0, 8) : filtered;

  return (
    <section className="surface p-5 mt-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="mt-1 text-xs muted">
            時刻 · 種別 · 目的 · 成否（接続状態と連動）
          </p>
        </div>
        <div
          className="inline-flex flex-wrap rounded-full border border-[var(--border)] p-0.5 self-start"
          role="group"
          aria-label="アクションログ絞り込み"
        >
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className="px-3 py-2.5 text-xs rounded-full transition-colors min-h-[40px]"
                style={
                  active
                    ? {
                        background: "var(--accent)",
                        color: "var(--accent-fg)",
                      }
                    : { color: "var(--text-muted)" }
                }
                aria-pressed={active}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm muted">該当するアクションがありません</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {shown.map((ev) => (
            <li
              key={ev.id}
              className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={typeChipClass(ev.actionType, ev.success)}>
                  {ACTION_TYPE_LABEL[ev.actionType]}
                </span>
                <span
                  className={
                    ev.success ? "chip chip-ok text-[11px]" : "chip chip-danger text-[11px]"
                  }
                >
                  {ev.success ? "成功" : "失敗"}
                </span>
                {ev.purpose ? (
                  <span className="text-[11px] faint">{ev.purpose}</span>
                ) : null}
                <span className="text-[11px] faint ml-auto tabular-nums">
                  {formatTs(ev.timestamp)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-snug break-words">{ev.summary}</p>
              {ev.costTip ? (
                <p className="mt-1 text-[11px] muted">コスト目安 {ev.costTip}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-[11px] faint">
        サンプル表示です。本番では監査の記録と、接続・承認の履歴が並びます。
        {compact && filtered.length > shown.length
          ? ` · ほか ${filtered.length - shown.length} 件`
          : null}
      </p>
    </section>
  );
}
