import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { ApprovalsClient } from "@/components/ApprovalsClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  getDemoApprovalsBackend,
  isDurableDemoApprovalsStore,
  listApprovals,
  listEmployees,
} from "@/lib/data";
import { isDemoMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const orgId = await getCurrentOrgId();
  const approvals = await listApprovals(orgId);
  const employees = await listEmployees(orgId);
  const demo = isDemoMode();

  return (
    <AppShell
      title="承認"
      subtitle="要対応 — 危険操作はここで許可してから実行"
    >
      <ApprovalsClient
        initial={approvals}
        employees={employees}
        demoDurable={demo ? isDurableDemoApprovalsStore() : true}
        demoStore={demo ? getDemoApprovalsBackend() : null}
      />
      <p className="mt-4 text-xs faint leading-relaxed">
        承認や却下のとき、関係者へメールでお知らせする想定です。Bot
        側の戻りは署名付きステータス poll が正本です。手順:{" "}
        <Link
          href="/app/guides/approval-loop"
          className="underline underline-offset-2 hover:opacity-80"
        >
          承認ループ運用
        </Link>
        。
      </p>
    </AppShell>
  );
}
