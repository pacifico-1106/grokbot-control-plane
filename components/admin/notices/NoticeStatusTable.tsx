import type { OperatorNoticeReceipt } from "@/lib/operator-notices/types";

const STATE_JA: Record<string, string> = {
  delivered: "届いた",
  read: "既読",
  applied: "反映",
  not_applicable: "対象外",
  needs_tenant_approval: "要テナント承認",
  declined: "見送り",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function NoticeStatusTable({
  receipts,
  staleAfterDays = 3,
}: {
  receipts: OperatorNoticeReceipt[];
  staleAfterDays?: number;
}) {
  const cutoff = Date.now() - staleAfterDays * 86400000;
  const rows = receipts.slice().sort((a, b) => a.orgId.localeCompare(b.orgId) || a.employeeId.localeCompare(b.employeeId));
  return (
    <div className="table-scroll">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead className="bg-[var(--bg-soft)] text-xs muted">
          <tr>
            <th className="px-4 py-3 font-semibold">テナント</th>
            <th className="px-4 py-3 font-semibold">社員</th>
            <th className="px-4 py-3 font-semibold">状態</th>
            <th className="px-4 py-3 font-semibold">届いた</th>
            <th className="px-4 py-3 font-semibold">既読</th>
            <th className="px-4 py-3 font-semibold">反映の根拠</th>
            <th className="px-4 py-3 font-semibold">wake</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-soft)]">
          {rows.map((r) => {
            const stale =
              (r.state === "delivered" || r.state === "read" || r.state === "needs_tenant_approval") &&
              Date.parse(r.firstListedAt) < cutoff;
            return (
              <tr key={`${r.noticeId}:${r.employeeId}`} className={stale ? "bg-[color-mix(in_oklab,var(--warn)_8%,transparent)]" : ""}>
                <td className="px-4 py-3 font-mono text-[11px]">{r.orgId}</td>
                <td className="px-4 py-3 font-mono text-[11px]">{r.employeeId}</td>
                <td className="px-4 py-3">
                  {STATE_JA[r.state] ?? r.state}
                  {stale ? <span className="ml-2 text-[11px] text-[var(--warn)]">3日未反映</span> : null}
                </td>
                <td className="px-4 py-3 text-xs">{formatDate(r.firstListedAt)}</td>
                <td className="px-4 py-3 text-xs">{formatDate(r.readAt)}</td>
                <td className="px-4 py-3 text-xs">{r.applyEvidence ?? "—"}</td>
                <td className="px-4 py-3 text-xs">{r.wakeState}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-sm muted">まだ受領行はありません。</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
