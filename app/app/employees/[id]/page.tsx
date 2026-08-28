import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { BindingPanel } from "@/components/employees/BindingPanel";
import { EmployeeActionLog } from "@/components/employees/EmployeeActionLog";
import { EmployeeManagerForm } from "@/components/employees/EmployeeManagerForm";
import { EmployeeIdentityForm } from "@/components/employees/EmployeeIdentityForm";
import { EmployeePolicyForm } from "@/components/employees/EmployeePolicyForm";
import { EmployeeVoiceForm } from "@/components/employees/EmployeeVoiceForm";
import { EmployeeProjectAccessForm } from "@/components/employees/EmployeeProjectAccessForm";
import { EmployeeTerminateForm } from "@/components/employees/EmployeeTerminateForm";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  ensureBindingRow,
  getBinding,
  getEmployee,
  listEmployees,
  listMembers,
  listOrgProjects,
} from "@/lib/data";
import { getEmployeeActionLog } from "@/lib/employee-actions-demo";
import { APPROVAL_POLICY_LABELS } from "@/lib/employees/policy-draft";
import { buildConcentration } from "@/lib/employees/concentration";
import { DOMAIN_LABELS } from "@/lib/gateway/domains";

export const dynamic = "force-dynamic";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const orgId = await getCurrentOrgId();
  const members = await listMembers(orgId);
  const projects = await listOrgProjects(orgId);

  if (id === "new") {
    return (
      <AppShell title="AI社員を雇う" subtitle="新規発行">
        <HireEmployeeClient members={members} projects={projects} />
      </AppShell>
    );
  }

  const employee = await getEmployee(id, orgId);
  if (!employee) notFound();
  const concentration = buildConcentration(await listEmployees(orgId));
  const concentrationRow = concentration.employees.find((row) => row.employeeId === employee.id);

  const binding =
    (await getBinding(employee.id)) ??
    (await ensureBindingRow(employee.id, employee.orgId || orgId || ""));

  const actionEvents = getEmployeeActionLog(employee, binding);

  return (
    <AppShell
      title={employee.displayName}
      subtitle={`${employee.roleLabel} · ${employee.status === "active" ? "稼働中" : employee.status === "suspended" ? "契約終了" : employee.status === "draft" ? "下書き" : employee.status}`}
    >
      <div className="flex flex-col sm:flex-row flex-wrap gap-2 mb-4">
        <Link href="/app/employees" className="btn btn-ghost text-sm w-full sm:w-auto">
          ← 一覧
        </Link>
        <Link href="/app/employees/new" className="btn btn-ghost text-sm w-full sm:w-auto">
          別のAI社員を雇う
        </Link>
        <Link
          href={`/app/employees/${employee.id}/actions`}
          className="btn btn-ghost text-sm w-full sm:w-auto"
        >
          詳細ログ
        </Link>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="surface p-5 space-y-3">
          <h2 className="text-sm font-medium">職務</h2>
          <EmployeeIdentityForm employee={employee} disabled={employee.status === "suspended"} />
          <p className="text-sm muted leading-relaxed">
            {employee.jobDescription || "（説明なし）"}
          </p>
          <dl className="text-sm space-y-2 pt-2">
            <div>
              <dt className="text-xs muted">社員証 ID</dt>
              <dd className="mt-1 font-mono text-xs">
                {employee.credentialId ?? "未発行"}
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">AI社員番号（変更なし）</dt>
              <dd className="mt-1 font-mono text-xs">{employee.id}</dd>
            </div>
          </dl>
        </section>

        <section className="surface p-5 space-y-3">
          <h2 className="text-sm font-medium">やらせること / 使う理由</h2>
          <EmployeePolicyForm employee={employee} disabled={employee.status === "suspended"} />
        </section>
      </div>

      <section className={`surface p-5 mt-4 ${employee.sodLevel === "force_human" ? "ring-1 ring-[color-mix(in_oklab,var(--danger)_52%,transparent)]" : ""}`}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">職務分離・権限集中</h2>
            <p className="mt-2 text-xs muted leading-relaxed">
              {employee.sodLevel === "force_human"
                ? employee.approvalPolicy === "always_human"
                  ? "複数の高リスク領域が混在しているため、すべての行為を人が承認します。権限を社員ごとに分けると自動化できる範囲が広がります。"
                  : "複数の高リスク領域が混在しています。警告を確認済みです。確定操作（送信・発注・日程確定）は今どおり人が止めます。"
                : employee.sodLevel === "warn"
                  ? "ブラウザ操作を許可しています。利用アカウントを限定し、共有セッションを定期的に確認してください。"
                  : "高リスク権限は分離されています。"}
            </p>
          </div>
          <span className={`chip shrink-0 ${employee.sodLevel === "force_human" ? (employee.approvalPolicy !== "always_human" ? "chip-warn" : "chip-danger") : employee.sodLevel === "warn" ? "chip-warn" : "chip-ok"}`}>
            {employee.sodLevel === "force_human"
              ? employee.approvalPolicy !== "always_human"
                ? "警告・承諾済み"
                : "全件承認"
              : employee.sodLevel === "warn" ? "要注意" : "分離済み"}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {(concentrationRow?.highRiskDomains ?? []).map((domain) => (
            <span key={domain} className="chip chip-warn text-[11px]">{DOMAIN_LABELS[domain]}</span>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-[var(--border-soft)] overflow-hidden">
            <div className="h-full rounded-full bg-[var(--warn)]" style={{ width: `${(concentrationRow?.share ?? 0) * 100}%` }} />
          </div>
          <span className="text-xs tabular-nums muted">組織内の {Math.round((concentrationRow?.share ?? 0) * 100)}%</span>
        </div>
        {Object.keys(employee.actionLimits).length ? (
          <details className="mt-4 rounded-xl border border-[var(--border-soft)] px-3 py-2">
            <summary className="text-xs cursor-pointer">行為上限</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(employee.actionLimits).map(([tool, limit]) => (
                <span key={tool} className="chip text-[11px]">
                  {tool}: {limit.perDay ? `日${limit.perDay}` : ""}{limit.perDay && limit.perMonth ? " / " : ""}{limit.perMonth ? `月${limit.perMonth}` : ""}
                </span>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">上長</h2>
        <p className="text-xs muted leading-relaxed">
          機密開示の承認チケットに上長IDを付けます。職務分離バッジはそのまま有効です。
        </p>
        <EmployeeManagerForm employee={employee} members={members} disabled={employee.status === "suspended"} />
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">ナレッジ範囲</h2>
        <p className="text-xs muted leading-relaxed">
          デフォルトは会社全般です。他案件のナレッジは社内にも出しません。指名プロジェクトはここで付与します。
        </p>
        <EmployeeProjectAccessForm employee={employee} projects={projects} disabled={employee.status === "suspended"} />
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">話し方</h2>
        <p className="text-xs muted leading-relaxed">
          丁寧・率直・カスタムは社員証に刻みます。対外の相手では丁寧が下限です。モデルは whoami の voice に従い、毎回ペルソナを自称しません。
        </p>
        <EmployeeVoiceForm employee={employee} disabled={employee.status === "suspended"} />
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">予算・承認（決済委任）</h2>
        {employee.spend ? (
          <dl className="grid sm:grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs muted">承認ポリシー</dt>
              <dd className="mt-1">{APPROVAL_POLICY_LABELS[employee.approvalPolicy]}</dd>
            </div>
            <div>
              <dt className="text-xs muted">1件あたり上限</dt>
              <dd className="mt-1">
                ¥{employee.spend.maxPerOrderJpy.toLocaleString("ja-JP")}
                {employee.spend.maxPerOrderJpy === 0 ? "（発注禁止）" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">日次 / 月次上限</dt>
              <dd className="mt-1">
                {employee.spend.maxPerDayJpy != null
                  ? `¥${employee.spend.maxPerDayJpy.toLocaleString("ja-JP")}`
                  : "未設定"}
                {" / "}
                {employee.spend.maxPerMonthJpy != null
                  ? `¥${employee.spend.maxPerMonthJpy.toLocaleString("ja-JP")}`
                  : "未設定"}
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">初回発注</dt>
              <dd className="mt-1">
                {employee.spend.firstOrderRequiresHuman !== false
                  ? "必ず人間承認"
                  : "上限内なら自動可"}
              </dd>
            </div>
            {employee.spend.merchantAllowTip ? (
              <div className="sm:col-span-2">
                <dt className="text-xs muted">買ってよいもののヒント</dt>
                <dd className="mt-1">{employee.spend.merchantAllowTip}</dd>
              </div>
            ) : null}
          </dl>
        ) : employee.scopes.includes("commerce:order") ? (
          <p className="text-sm text-[var(--warn)]">
            発注は許可されていますが、予算が未設定です。承認されるまで実行しません（人が確認します）。
          </p>
        ) : (
          <p className="text-sm muted">
            いまは発注の権限がありません。必要になったら、権限を更新するときに予算を決められます。
          </p>
        )}
        <p className="text-xs faint leading-relaxed">
          実際の発注・送信は、承認・監査を通す仕組み（Staffpass）経由だけです。
        </p>
      </section>


      <BindingPanel employeeId={employee.id} initial={binding} />

      <EmployeeTerminateForm employee={employee} />

      <EmployeeActionLog events={actionEvents} compact />
    </AppShell>
  );
}
