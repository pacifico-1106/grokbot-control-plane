import Link from "next/link";
import Image from "next/image";
import { AppShell } from "@/components/AppShell";
import { getCurrentOrgId } from "@/lib/auth/session";
import { listEmployees } from "@/lib/data";
import { APPROVAL_POLICY_LABELS } from "@/lib/employees/policy-draft";
import { buildConcentration } from "@/lib/employees/concentration";
import { DOMAIN_LABELS } from "@/lib/gateway/domains";
import type { Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

function EmployeePassCard({ employee }: { employee: Employee }) {
  return (
    <div className="employee-pass relative overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--accent-strong)_28%,var(--border))] bg-[linear-gradient(135deg,#0b1720,#081017)] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
      <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-[var(--accent-glow)] blur-2xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Image src="/brand/staffpass-mark-dark-v2.png" alt="" width={26} height={26} className="object-contain" />
          <div>
            <span className="block text-[8px] font-mono tracking-[0.16em] text-[var(--accent-strong)]">AI EMPLOYEE PASS</span>
            <span className="mt-0.5 block text-[9px] faint">STAFFPASS / SEALITH</span>
          </div>
        </div>
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${employee.status === "active" ? "bg-[var(--ok)] shadow-[0_0_10px_var(--ok)]" : "bg-[var(--warn)]"}`} />
      </div>
      <div className="relative mt-5">
        <div className="text-base font-bold tracking-tight break-words">{employee.displayName}</div>
        <div className="mt-1 text-[11px] muted break-words">{employee.roleLabel}</div>
      </div>
      <div className="relative mt-4 flex items-end justify-between gap-3 border-t border-white/8 pt-2.5">
        <span className="text-[8px] faint tracking-wider">EMPLOYEE ID</span>
        <span className="font-mono text-[9px] text-[var(--text-muted)]">{employee.id.slice(-12).toUpperCase()}</span>
      </div>
    </div>
  );
}

export default async function EmployeesPage() {
  const orgId = await getCurrentOrgId();
  const employees = await listEmployees(orgId);
  const concentration = buildConcentration(employees);
  const concentrationById = new Map(concentration.employees.map((row) => [row.employeeId, row]));

  return (
    <AppShell title="AI社員">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-sm muted break-words min-w-0">
          日本語で職務を説明 → 権限の案 → 社員証発行。危ない操作は承認待ちへ
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
                  <EmployeePassCard employee={e} />
                  <div className="mt-3">
                    <span className="chip text-[11px] break-words max-w-full">
                      {APPROVAL_POLICY_LABELS[e.approvalPolicy]}
                    </span>
                  </div>
                  {(() => {
                    const row = concentrationById.get(e.id);
                    if (!row?.highRiskDomains.length) return null;
                    return <div className="mt-3">
                      <div className="flex flex-wrap gap-1.5">
                        {row.highRiskDomains.map((domain) => <span key={domain} className="chip chip-warn text-[10px]">{DOMAIN_LABELS[domain]}</span>)}
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-[var(--border-soft)] overflow-hidden">
                        <div className="h-full rounded-full bg-[var(--warn)]" style={{ width: `${row.share * 100}%` }} />
                      </div>
                    </div>;
                  })()}
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
                    <th className="px-4 py-3 font-medium">高リスク領域</th>
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
                      <td className="px-4 py-3 min-w-[250px]">
                        <Link
                          href={`/app/employees/${e.id}`}
                          className="absolute inset-0 z-0"
                          aria-label={`${e.displayName}の詳細`}
                        />
                        <div className="relative z-[1] pointer-events-none"><EmployeePassCard employee={e} /></div>
                      </td>
                      <td className="px-4 py-3 muted relative z-[1] pointer-events-none">
                        {e.roleLabel}
                      </td>
                      <td className="px-4 py-3 relative z-[1] pointer-events-none">
                        <span className="chip text-[11px]">
                          {APPROVAL_POLICY_LABELS[e.approvalPolicy]}
                        </span>
                      </td>
                      <td className="px-4 py-3 relative z-[1] pointer-events-none min-w-48">
                        {(() => {
                          const row = concentrationById.get(e.id);
                          if (!row?.highRiskDomains.length) return <span className="text-xs faint">なし</span>;
                          return <div>
                            <div className="flex flex-wrap gap-1">{row.highRiskDomains.map((domain) => <span key={domain} className="chip chip-warn text-[10px]">{DOMAIN_LABELS[domain]}</span>)}</div>
                            <div className="mt-2 h-1.5 rounded-full bg-[var(--border-soft)] overflow-hidden"><div className="h-full rounded-full bg-[var(--warn)]" style={{ width: `${row.share * 100}%` }} /></div>
                          </div>;
                        })()}
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
