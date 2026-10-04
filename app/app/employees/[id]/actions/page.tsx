import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { EmployeeActionLog } from "@/components/employees/EmployeeActionLog";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getBindingForDisplay, getEmployee } from "@/lib/data";
import { getEmployeeActionLog } from "@/lib/employee-actions-demo";

export const dynamic = "force-dynamic";

export default async function EmployeeActionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) notFound();

  // Read-only: a missing row shows as 未接続; only admin actions create it.
  const binding = await getBindingForDisplay(employee.id, employee.orgId || orgId || "");
  const actionEvents = getEmployeeActionLog(employee, binding);

  return (
    <AppShell
      title={`${employee.displayName} · アクションログ`}
      subtitle={`${employee.roleLabel} · 詳細タイムライン`}
    >
      <div className="flex flex-wrap gap-2 mb-4">
        <Link
          href={`/app/employees/${employee.id}`}
          className="btn btn-ghost text-xs px-3 py-1.5"
        >
          ← 社員詳細
        </Link>
        <Link href="/app/employees" className="btn btn-ghost text-xs px-3 py-1.5">
          一覧
        </Link>
        <Link href="/app/audit" className="btn btn-ghost text-xs px-3 py-1.5">
          組織監査
        </Link>
      </div>

      <EmployeeActionLog events={actionEvents} title="アクションログ（全件）" />
    </AppShell>
  );
}
