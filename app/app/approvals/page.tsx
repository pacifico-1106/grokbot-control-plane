import { AppShell } from "@/components/AppShell";
import { DEMO_APPROVALS, DEMO_EMPLOYEES } from "@/lib/demo-data";

export default function ApprovalsPage() {
  return (
    <AppShell
      title="承認キュー"
      subtitle="危険操作はここで許可してから実行されます"
    >
      <div className="surface overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-xs muted border-b border-[var(--border)]">
            <tr>
              <th className="px-4 py-3 font-medium">内容</th>
              <th className="px-4 py-3 font-medium hidden md:table-cell">AI社員</th>
              <th className="px-4 py-3 font-medium">リスク</th>
              <th className="px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_APPROVALS.map((a) => {
              const emp = DEMO_EMPLOYEES.find((e) => e.id === a.employeeId);
              return (
                <tr key={a.id} className="border-b border-[var(--border-soft)]">
                  <td className="px-4 py-4 align-top">
                    <div className="font-medium leading-snug">{a.summary}</div>
                    <div className="text-xs faint mt-1">{a.purpose}</div>
                  </td>
                  <td className="px-4 py-4 align-top hidden md:table-cell muted">
                    {emp?.displayName ?? a.employeeId}
                  </td>
                  <td className="px-4 py-4 align-top">
                    <span
                      className={`chip ${
                        a.risk === "high"
                          ? "chip-danger"
                          : a.risk === "medium"
                            ? "chip-warn"
                            : "chip-ok"
                      }`}
                    >
                      {a.risk}
                    </span>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn btn-primary text-xs px-3 py-1.5">
                        承認
                      </button>
                      <button type="button" className="btn btn-ghost text-xs px-3 py-1.5">
                        却下
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs faint">
        承認 / 却下時は Resend で通知メール（approval_requested / approval_resolved）を送る想定です。
      </p>
    </AppShell>
  );
}
