import { AppShell } from "@/components/AppShell";
import { ApprovalsClient } from "@/components/ApprovalsClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import { listApprovals, listEmployees } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const orgId = await getCurrentOrgId();
  const approvals = await listApprovals(orgId);
  const employees = await listEmployees(orgId);

  return (
    <AppShell
      title="承認"
      subtitle="要対応 — 危険操作はここで許可してから実行"
    >
      <ApprovalsClient
        initial={approvals}
        employees={employees}
      />
      <p className="mt-4 text-xs faint">
        承認や却下のとき、関係者へメールでお知らせする想定です。
      </p>
    </AppShell>
  );
}
