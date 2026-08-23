import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { BindingPanel } from "@/components/employees/BindingPanel";
import { EmployeeActionLog } from "@/components/employees/EmployeeActionLog";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  ensureBindingRow,
  getBinding,
  getEmployee,
} from "@/lib/data";
import { getEmployeeActionLog } from "@/lib/employee-actions-demo";
import { serviceLabel } from "@/lib/employees/allowed-accounts";
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

  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) notFound();

  const binding =
    (await getBinding(employee.id)) ??
    (await ensureBindingRow(employee.id, employee.orgId || orgId || ""));

  const actionEvents = getEmployeeActionLog(employee, binding);

  return (
    <AppShell
      title={employee.displayName}
      subtitle={`${employee.roleLabel} · ${employee.status === "active" ? "稼働中" : employee.status === "suspended" ? "一時停止" : employee.status === "draft" ? "下書き" : employee.status}`}
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
              <dt className="text-xs muted">AI社員番号（変更なし）</dt>
              <dd className="mt-1 font-mono text-xs">{employee.id}</dd>
            </div>
          </dl>
        </section>

        <section className="surface p-5 space-y-3">
          <h2 className="text-sm font-medium">できること / 目的</h2>
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


      <section className="surface p-5 space-y-3 mt-4">
        <h2 className="text-sm font-medium">ブラウザ・外部アカウント</h2>
        <p className="text-xs muted leading-relaxed">
          共有PCではログインが混ざる可能性があるため、社員証に刻んだ許可IDのみ使う想定です。不一致時は要確認／停止。
        </p>
        <dl className="text-sm space-y-2">
          <div>
            <dt className="text-xs muted">ブラウザ利用</dt>
            <dd className="mt-1">
              {employee.scopes.includes("browser:use") ? (
                <span className="chip chip-ok text-[11px]">許可</span>
              ) : (
                <span className="chip text-[11px]">未許可</span>
              )}
            </dd>
          </div>
        </dl>
        {(employee.allowedAccounts ?? []).length > 0 ? (
          <ul className="space-y-2">
            {(employee.allowedAccounts ?? []).map((a, i) => (
              <li
                key={`${a.service}-${a.accountId}-${i}`}
                className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip chip-ok text-[11px]">
                    {serviceLabel(a.service)}
                  </span>
                  {a.browserRequired ? (
                    <span className="chip text-[11px]">ブラウザ一致重視</span>
                  ) : null}
                </div>
                <p className="mt-1 font-mono text-xs break-all">{a.accountId}</p>
                {a.label ? (
                  <p className="mt-1 text-xs muted">{a.label}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm muted">
            許可アカウントが未登録です。ブラウザを使う場合は、権限の更新で使えるIDを登録してください。
          </p>
        )}
        <p className="text-xs faint leading-relaxed">
          実行中のログイン確認は、すべてを自動では見切れない場合があります。方針・監査・当社サポートの目視と合わせて運用してください。
        </p>
      </section>

      <BindingPanel employeeId={employee.id} initial={binding} />

      <EmployeeActionLog events={actionEvents} compact />
    </AppShell>
  );
}
