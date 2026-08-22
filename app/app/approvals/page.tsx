import { AppShell } from "@/components/AppShell";
import { ApprovalsClient } from "@/components/ApprovalsClient";
import { getRuntimeApprovals, getRuntimeEmployees } from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <AppShell
      title="承認"
      subtitle="要対応 — 危険操作はここで許可してから実行"
    >
      <ApprovalsClient
        initial={getRuntimeApprovals()}
        employees={getRuntimeEmployees()}
      />
      <p className="mt-4 text-xs faint">
        承認 / 却下時は Resend で approval_needed / approval_resolved を送る想定です。
      </p>
    </AppShell>
  );
}
