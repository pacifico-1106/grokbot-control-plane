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
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-sm muted break-words min-w-0">
          日本語で職務を説明 → 権限の案 → 社員証発行。危ない操作は承認待ちへ。
        </p>
        <Link
          href="/app/employees/new"
          className="btn btn-primary text-sm w-full sm:w-auto shrink-0"
        >
          AI社員を雇う
        </Link>
      </div>

      {employees.length === 0 ? (
        <section className="surface p-6 sm:p-8 text-center">
          <p className="text-sm font-medium">まだ AI社員がいません</p>
          <p className="mt-2 text-sm muted leading-relaxed max-w-md mx-auto break-words">
            最初の一人を雇うと、できること・目的・承認のルール付きの社員証が発行されます。
          </p>
          <Link
            href="/app/employees/new"
            className="btn btn-primary mt-5 text-sm inline-flex w-full sm:w-auto"
          >
            最初の AI社員を雇う
          </Link>
        </section>
      ) : (
        <>
          {/* Mobile card stack */}
          <ul className="md:hidden space-y-3">
            {employees.map((e) => (
              <li key={e.id} className="surface p-4 space-y-3 min-w-0">
                <Link
                  href={`/app/employees/${e.id}`}
                  className="block min-w-0 -m-1 p-1 rounded-md hover:bg-[var(--bg-soft)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm break-words">
                        {e.displayName}
                      </div>
                      <div className="text-xs muted mt-1 break-words">
                        {e.roleLabel}
                      </div>
                    </div>
                    <span
                      className={`chip shrink-0 ${
                        e.status === "active" ? "chip-ok" : "chip-warn"
                      }`}
                    >
                      {e.status === "active"
                        ? "稼働中"
                        : e.status === "suspended"
                          ? "一時停止"
                          : e.status === "draft"
                            ? "下書き"
                            : e.status}
                    </span>
                  </div>
                  <div className="mt-3">
                    <span className="chip text-[11px] break-words max-w-full">
                      {APPROVAL_POLICY_LABELS[e.approvalPolicy]}
                    </span>
                  </div>
                </Link>
                <Link
                  href={`/app/employees/${e.id}/actions`}
                  className="text-xs muted underline underline-offset-2 min-h-[44px] inline-flex items-center"
                >
                  アクションログ
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <div className="surface overflow-hidden hidden md:block">
            <div className="table-scroll">
              <table className="w-full text-sm">
                <thead className="text-left text-xs muted border-b border-[var(--border)]">
                  <tr>
                    <th className="px-4 py-3 font-medium">名前</th>
                    <th className="px-4 py-3 font-medium">職務</th>
                    <th className="px-4 py-3 font-medium">承認</th>
                    <th className="px-4 py-3 font-medium">状態</th>
                    <th className="px-4 py-3 font-medium">ログ</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr
                      key={e.id}
                      className="border-b border-[var(--border-soft)] relative hover:bg-[var(--bg-soft)] group"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/app/employees/${e.id}`}
                          className="absolute inset-0 z-0"
                          aria-label={`${e.displayName}の詳細`}
                        />
                        <span className="relative z-[1] font-medium group-hover:underline underline-offset-2">
                          {e.displayName}
                        </span>
                      </td>
                      <td className="px-4 py-3 muted relative z-[1] pointer-events-none">
                        {e.roleLabel}
                      </td>
                      <td className="px-4 py-3 relative z-[1] pointer-events-none">
                        <span className="chip text-[11px]">
                          {APPROVAL_POLICY_LABELS[e.approvalPolicy]}
                        </span>
                      </td>
                      <td className="px-4 py-3 relative z-[1] pointer-events-none">
                        <span
                          className={`chip ${
                            e.status === "active" ? "chip-ok" : "chip-warn"
                          }`}
                        >
                          {e.status === "active"
                            ? "稼働中"
                            : e.status === "suspended"
                              ? "一時停止"
                              : e.status === "draft"
                                ? "下書き"
                                : e.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 relative z-[1]">
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
          </div>
        </>
      )}
    </AppShell>
  );
}
