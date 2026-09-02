import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { BindingPanel } from "@/components/employees/BindingPanel";
import { EmployeeActionLog } from "@/components/employees/EmployeeActionLog";
import { EmployeeManagerForm } from "@/components/employees/EmployeeManagerForm";
import { EmployeeApprovalInboxForm } from "@/components/employees/EmployeeApprovalInboxForm";
import { EmployeeIdentityForm } from "@/components/employees/EmployeeIdentityForm";
import { EmployeePolicyForm } from "@/components/employees/EmployeePolicyForm";
import { EmployeeVoiceForm } from "@/components/employees/EmployeeVoiceForm";
import { EmployeeProjectAccessForm } from "@/components/employees/EmployeeProjectAccessForm";
import { EmployeeTerminateForm } from "@/components/employees/EmployeeTerminateForm";
import { SlackIdentityForm } from "@/components/employees/SlackIdentityForm";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  ensureBindingRow,
  getBinding,
  getEmployee,
  getEmployeeSlackIdentity,
  getOrgSodWarnPolicy,
  listEmployees,
  listMembers,
  listNotificationChannels,
  listOrgProjects,
} from "@/lib/data";
import { slackOAuthConfigured } from "@/lib/slack/oauth";
import { getEmployeeActionLog } from "@/lib/employee-actions-demo";
import { assignedInboxLabel } from "@/lib/employees/approval-inbox";
import { APPROVAL_POLICY_LABELS } from "@/lib/employees/policy-draft";
import { buildConcentration } from "@/lib/employees/concentration";
import { DOMAIN_LABELS } from "@/lib/gateway/domains";
import { evaluateSod, isComboSodWarn } from "@/lib/employees/sod";

export const dynamic = "force-dynamic";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (id === "new") {
    redirect("/app/getting-started");
  }

  const orgId = await getCurrentOrgId();
  const members = await listMembers(orgId);
  const projects = await listOrgProjects(orgId);
  const sodWarnPolicy = await getOrgSodWarnPolicy(orgId);
  const notificationChannels = await listNotificationChannels(orgId);

  const employee = await getEmployee(id, orgId);
  if (!employee) notFound();
  const concentration = buildConcentration(await listEmployees(orgId));
  const concentrationRow = concentration.employees.find((row) => row.employeeId === employee.id);

  const binding =
    (await getBinding(employee.id)) ??
    (await ensureBindingRow(employee.id, employee.orgId || orgId || ""));
  const slackIdentity = await getEmployeeSlackIdentity(employee.id);
  const oauthConfigured = slackOAuthConfigured();

  const actionEvents = getEmployeeActionLog(employee, binding);

  return (
    <AppShell
      title={employee.displayName}
      subtitle={`${employee.roleLabel} · ${employee.status === "active" ? "稼働中" : employee.status === "suspended" ? "契約終了" : employee.status === "draft" ? "下書き" : employee.status}`}
    >
      <div className="flex flex-col sm:flex-row flex-wrap gap-2 mb-4">
        <span className="chip text-[11px]">承認の届き先: {assignedInboxLabel(employee, notificationChannels)}</span>
        <Link href="/app/employees" className="btn btn-ghost text-sm w-full sm:w-auto">
          ← 一覧
        </Link>
        <Link href="/app/getting-started" className="btn btn-ghost text-sm w-full sm:w-auto">
          セットアップ
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
          <EmployeePolicyForm
            employee={employee}
            slackLinked={slackIdentity?.status === "linked"}
            disabled={employee.status === "suspended"}
            readOnly
            sodWarnPolicy={sodWarnPolicy}
          />
        </section>
      </div>

      <section className={`surface p-5 mt-4 ${isComboSodWarn(evaluateSod(employee.scopes, sodWarnPolicy)) ? "ring-1 ring-[color-mix(in_oklab,var(--warn)_40%,transparent)]" : ""}`}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">職務分離・権限集中</h2>
            <p className="mt-2 text-xs muted leading-relaxed">
              {isComboSodWarn(evaluateSod(employee.scopes, sodWarnPolicy))
                ? "高リスク権限を同時に持たせています。責任は事業者にあります。警告と承諾だけで、行為は止めません。"
                : employee.sodLevel === "warn"
                  ? "ブラウザ操作を許可しています。利用アカウントを限定し、共有セッションを定期的に確認してください。"
                  : "高リスク権限は分離されています。"}
            </p>
          </div>
          <span className={`chip shrink-0 ${isComboSodWarn(evaluateSod(employee.scopes, sodWarnPolicy)) ? "chip-warn" : employee.sodLevel === "warn" ? "chip-warn" : "chip-ok"}`}>
            {isComboSodWarn(evaluateSod(employee.scopes, sodWarnPolicy))
              ? "要注意"
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
        <h2 className="text-sm font-medium">承認の届き先</h2>
        <p className="text-xs muted leading-relaxed">
          この社員の承認カードをどのインボックスに届けるか。未指定は組織の既定です。会話の書き込みとは別です。
        </p>
        <EmployeeApprovalInboxForm
          employee={employee}
          channels={notificationChannels}
          disabled={employee.status === "suspended"}
        />
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">ナレッジ範囲</h2>
        <p className="text-xs muted leading-relaxed">
          デフォルトは会社全般です。他案件のナレッジは社内にも出しません。指名プロジェクトはここで付与します。
        </p>
        <EmployeeProjectAccessForm employee={employee} projects={projects} disabled={employee.status === "suspended"} />
      </section>

      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">Slack 投稿名義</h2>
        <p className="text-xs muted leading-relaxed">
          会社のBotか、この社員本人か。本人で出すには許可アカウントの Slack ID（U…）と OAuth 連携が必要です。
        </p>
        <SlackIdentityForm
          employee={employee}
          initialIdentity={slackIdentity}
          oauthConfigured={oauthConfigured}
          disabled={employee.status === "suspended"}
        />
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
