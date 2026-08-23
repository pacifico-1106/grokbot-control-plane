import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getOrgMeta, listEmployees } from "@/lib/data";
import { APPROVAL_POLICY_LABELS } from "@/lib/employees/policy-draft";

export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  const orgId = await getCurrentOrgId();
  const employees = await listEmployees(orgId);
  const org = await getOrgMeta(orgId);

  return (
    <AppShell
      title="AI社員"
      subtitle={`${org.name} · 社員証付きの職務分掌`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm muted">
          日本語で職務を説明 → Draft → 社員証発行。危険操作は承認ゲートへ。
        </p>
        <Link href="/app/employees/new" className="btn btn-primary text-sm">
          AI社員を雇う
        </Link>
      </div>

      {employees.length === 0 ? (
        <section className="surface p-8 text-center">
          <p className="text-sm font-medium">まだ AI社員がいません</p>
          <p className="mt-2 text-sm muted leading-relaxed max-w-md mx-auto">
            最初の一人を雇うと、スコープ・目的・承認ポリシー付きの社員証が発行されます。
          </p>
          <Link href="/app/employees/new" className="btn btn-primary mt-5 text-sm inline-flex">
            最初の AI社員を雇う
          </Link>
        </section>
      ) : (
        <div className="surface overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left text-xs muted border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-3 font-medium">名前</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">職務</th>
                <th className="px-4 py-3 font-medium">承認</th>
                <th className="px-4 py-3 font-medium">状態</th>
                <th className="px-4 py-3 font-medium">ログ</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className="border-b border-[var(--border-soft)]">
                  <td className="px-4 py-3">
                    <Link
                      href={`/app/employees/${e.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {e.displayName}
                    </Link>
                    <div className="text-xs faint mt-1 md:hidden">{e.roleLabel}</div>
                  </td>
                  <td className="px-4 py-3 muted hidden md:table-cell">
                    {e.roleLabel}
                  </td>
                  <td className="px-4 py-3">
                    <span className="chip text-[11px]">
                      {APPROVAL_POLICY_LABELS[e.approvalPolicy]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`chip ${
                        e.status === "active" ? "chip-ok" : "chip-warn"
                      }`}
                    >
                      {e.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/app/employees/${e.id}/actions`}
                      className="text-xs muted underline underline-offset-2"
                    >
                      アクション
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
