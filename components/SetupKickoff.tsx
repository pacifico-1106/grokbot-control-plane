import Link from "next/link";
import { AdminMcpConnect } from "@/components/AdminMcpConnect";
import { OpsDocLocationForm } from "@/components/OpsDocLocationForm";
import { SETUP_STEPS } from "@/lib/dashboard/setup-state";

export function SetupKickoff({
  adminConnected,
  grokBotAgentId,
  opsDocLocation,
  confirmedEmployeeCount,
}: {
  adminConnected: boolean;
  grokBotAgentId: string | null;
  opsDocLocation: string | null;
  confirmedEmployeeCount: number;
}) {
  return (
    <div className="space-y-4">
      <section className="surface p-5">
        <p className="text-xs faint font-mono">KICKOFF</p>
        <h2 className="mt-2 text-sm font-medium">最初のセットアップ</h2>
        <p className="mt-2 text-sm muted leading-relaxed">
          アカウント → 管理MCP接続 → 工程の正本（ドキュメントまたは音声またはテキスト。必須はどれか一つ） →
          社員を1人ずつ人確認 → 承認者と通知口 → コネクタ認証。
          職務ウィザードを毎日の入口にはしません。
        </p>
      </section>

      {SETUP_STEPS.map((step, i) => (
        <section
          key={step.id}
          className="surface p-5 space-y-3"
          id={step.id === "process-source" ? "process-source" : step.id === "admin-mcp" ? "admin-mcp" : undefined}
        >
          <p className="text-xs faint font-mono">STEP {String(i + 1).padStart(2, "0")}</p>
          <h3 className="text-sm font-medium">{step.title}</h3>
          <p className="text-sm muted leading-relaxed">{step.body}</p>
          {step.id === "admin-mcp" ? (
            <AdminMcpConnect connected={adminConnected} grokBotAgentId={grokBotAgentId} embedded />
          ) : null}
          {step.id === "process-source" ? <OpsDocLocationForm initial={opsDocLocation} /> : null}
          {step.id === "confirm-employees" ? (
            <p className="text-xs muted">人確認済みの社員: {confirmedEmployeeCount} 人</p>
          ) : null}
          {step.id !== "admin-mcp" && step.id !== "process-source" ? (
            <Link href={step.href} className="btn btn-ghost text-sm w-full sm:w-auto inline-flex">
              {step.label}
            </Link>
          ) : null}
        </section>
      ))}
    </div>
  );
}
