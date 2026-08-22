import { AppShell } from "@/components/AppShell";
import { DEMO_AUDIT } from "@/lib/demo-data";

export default function AuditPage() {
  return (
    <AppShell
      title="監査ログ"
      subtitle="構造化証跡 — プロンプト全文ではなく、誰が・何目的で・何をしたか"
    >
      <div className="space-y-3">
        {DEMO_AUDIT.map((ev) => (
          <article key={ev.id} className="surface p-4">
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
            <p className="mt-3 text-sm leading-relaxed">{ev.summary}</p>
            <pre className="mt-3 text-[11px] faint overflow-x-auto font-mono">
              {JSON.stringify(ev.metadata, null, 2)}
            </pre>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
