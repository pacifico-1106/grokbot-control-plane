import Link from "next/link";
import { leadChangeLogEvents, CHANGE_LOG_EMPTY_JA, CHANGE_LOG_LEAD_JA } from "@/lib/dashboard/change-log";

export type ChangeLogItem = {
  id?: string;
  action: string;
  summary?: string | null;
  createdAt: string;
  employeeId?: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  "admin.hire": "雇用",
  "admin.policy": "権限",
  "admin.parties": "相手台帳",
  "admin.channel": "チャネル",
  "admin.link": "連携",
  "admin.role": "職務案",
};

export function ChangeLog({
  events,
  names,
}: {
  events: ChangeLogItem[];
  names?: Record<string, string>;
}) {
  const lead = leadChangeLogEvents(events).slice(0, 20);
  return (
    <section className="surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{CHANGE_LOG_LEAD_JA}</h2>
          <p className="mt-1 text-xs muted">送信や tool.invoke は混ぜません。閲覧は監査へ。</p>
        </div>
        <Link href="/app/audit" className="text-xs muted underline">
          閲覧
        </Link>
      </div>
      {lead.length === 0 ? (
        <p className="mt-4 text-sm muted">{CHANGE_LOG_EMPTY_JA}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {lead.map((event, i) => (
            <li
              key={event.id || `${event.action}-${event.createdAt}-${i}`}
              className="rounded-lg border border-[var(--border-soft)] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{ACTION_LABEL[event.action] || event.action}</span>
                {event.employeeId && names?.[event.employeeId] ? (
                  <span className="text-xs muted">{names[event.employeeId]}</span>
                ) : null}
                <span className="text-[11px] faint ml-auto">
                  {new Date(event.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{" "}
                  JST
                </span>
              </div>
              {event.summary ? (
                <p className="mt-2 text-sm leading-snug">{event.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
