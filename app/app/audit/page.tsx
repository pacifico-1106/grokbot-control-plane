import { AppShell } from "@/components/AppShell";
import { getCurrentOrgId } from "@/lib/auth/session";
import { listAuditEvents } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const orgId = await getCurrentOrgId();
  const events = await listAuditEvents(orgId);

  return (
    <AppShell
      title="監査"
      subtitle="タイムライン — 誰が・何目的で・何をしたか（プロンプト全文ではない）"
    >
      {events.length === 0 ? (
        <section className="surface p-8 text-center">
          <p className="text-sm muted">まだ監査イベントがありません</p>
        </section>
      ) : (
        <div className="relative space-y-0 pl-3 sm:pl-4 border-l border-[var(--border)] min-w-0">
          {events.map((ev) => (
            <article key={ev.id} className="relative pb-6">
              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--text-faint)] ring-4 ring-[var(--bg)]" />
              <div className="surface p-4 ml-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">{ev.action}</span>
                  {ev.purpose ? (
                    <span className="text-xs faint">{ev.purpose}</span>
                  ) : null}
                  <span className="text-xs faint ml-auto">
                    {new Date(ev.createdAt).toLocaleString("ja-JP", {
                      timeZone: "Asia/Tokyo",
                    })}{" "}
                    JST
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed break-words">{ev.summary}</p>
                <pre className="mt-3 text-[11px] faint overflow-x-auto font-mono">
                  {JSON.stringify(ev.metadata, null, 2)}
                </pre>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
