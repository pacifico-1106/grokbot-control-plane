import { AppShell } from "@/components/AppShell";
import { DEMO_MEMBERS, DEMO_ORG } from "@/lib/demo-data";

const ROLE_HELP = [
  {
    role: "オーナー",
    body: "請求・メンバー権限・AI社員の発行/失効・連携設定を管理します。",
  },
  {
    role: "管理者",
    body: "AI社員の雇用・承認・監査を運用します。請求の契約変更はオーナーのみ。",
  },
];

export default function TeamPage() {
  return (
    <AppShell
      title="チーム"
      subtitle={`${DEMO_ORG.name} · SME 向けシンプル組織`}
    >
      <div className="grid lg:grid-cols-3 gap-4">
        <section className="surface p-5 lg:col-span-2">
          <h2 className="text-sm font-medium">メンバー</h2>
          <ul className="mt-4 divide-y divide-[var(--border-soft)]">
            {DEMO_MEMBERS.map((m) => (
              <li
                key={m.id}
                className="py-3 flex flex-wrap items-center justify-between gap-2"
              >
                <div>
                  <div className="text-sm">{m.displayName}</div>
                  <div className="text-xs muted">{m.email}</div>
                </div>
                <span className="chip">{m.role}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 rounded-lg border border-dashed border-[var(--border)] p-4">
            <p className="text-sm muted">招待（スタブ）</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="email"
                placeholder="member@example.com"
                className="flex-1 min-w-[200px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                disabled
              />
              <select
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                disabled
                defaultValue="admin"
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
              <button type="button" className="btn btn-primary text-sm" disabled>
                招待する
              </button>
            </div>
            <p className="mt-2 text-xs faint">
              Supabase Auth 接続後に有効化。SME では owner / admin が中心です。
            </p>
          </div>
        </section>
        <section className="surface p-5 space-y-4">
          <h2 className="text-sm font-medium">権限の考え方</h2>
          {ROLE_HELP.map((r) => (
            <div key={r.role}>
              <div className="text-sm">{r.role}</div>
              <p className="mt-1 text-xs muted leading-relaxed">{r.body}</p>
            </div>
          ))}
        </section>
      </div>
    </AppShell>
  );
}
