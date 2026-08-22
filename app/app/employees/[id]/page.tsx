import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { BindingPanel } from "@/components/employees/BindingPanel";
import { EmployeeActionLog } from "@/components/employees/EmployeeActionLog";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";
import { ensureBindingRow, getBinding } from "@/lib/bindings";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { getEmployeeActionLog } from "@/lib/employee-actions-demo";
import {
  APPROVAL_POLICY_LABELS,
  SCOPE_LABELS,
} from "@/lib/employees/policy-draft";
import type { EmployeeScope } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (id === "new") {
    return (
      <AppShell title="AI社員を雇う" subtitle="新規発行">
        <HireEmployeeClient />
      </AppShell>
    );
  }

  const employee = getRuntimeEmployees().find((e) => e.id === id);
  if (!employee) notFound();

  const binding =
    getBinding(employee.id) ??
    ensureBindingRow(employee.id, employee.orgId || DEMO_ORG.id);

  const actionEvents = getEmployeeActionLog(employee, binding);

  return (
    <AppShell
      title={employee.displayName}
      subtitle={`${employee.roleLabel} · ${employee.status}`}
    >
      <div className="flex flex-wrap gap-2 mb-4">
        <Link href="/app/employees" className="btn btn-ghost text-xs px-3 py-1.5">
          ← 一覧
        </Link>
        <Link href="/app/employees/new" className="btn btn-ghost text-xs px-3 py-1.5">
          別のAI社員を雇う
        </Link>
        <Link
          href={`/app/employees/${employee.id}/actions`}
          className="btn btn-ghost text-xs px-3 py-1.5"
        >
          詳細ログ
        </Link>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="surface p-5 space-y-3">
          <h2 className="text-sm font-medium">職務</h2>
          <p className="text-sm muted leading-relaxed">
            {employee.jobDescription || "（説明なし）"}
          </p>
          <dl className="text-sm space-y-2 pt-2">
            <div>
              <dt className="text-xs muted">承認ポリシー</dt>
              <dd className="mt-1">
                {APPROVAL_POLICY_LABELS[employee.approvalPolicy]}
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">社員証 ID</dt>
              <dd className="mt-1 font-mono text-xs">
                {employee.credentialId ?? "未発行"}
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">employeeId（生涯不変）</dt>
              <dd className="mt-1 font-mono text-xs">{employee.id}</dd>
            </div>
          </dl>
        </section>

        <section className="surface p-5 space-y-3">
          <h2 className="text-sm font-medium">スコープ / 目的</h2>
          <div className="flex flex-wrap gap-2">
            {(employee.scopes ?? []).map((s) => (
              <span key={s} className="chip chip-ok text-[11px]">
                {SCOPE_LABELS[s as EmployeeScope] ?? s}
              </span>
            ))}
          </div>
          <ul className="mt-3 space-y-1 text-sm muted">
            {(employee.allowedPurposes ?? []).map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
        </section>
      </div>

      <BindingPanel employeeId={employee.id} initial={binding} />

      <EmployeeActionLog events={actionEvents} compact />
    </AppShell>
  );
}
