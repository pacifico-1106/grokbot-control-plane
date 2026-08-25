import { AppShell } from "@/components/AppShell";
import { IntegrationsClient } from "@/components/IntegrationsClient";
import { McpSetupContent } from "@/components/mcp/McpSetupContent";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  ensureBindingRow,
  getBinding,
  getGatewayStatusForOrg,
  getOrgMeta,
  listEmployees,
} from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const orgId = await getCurrentOrgId();
  const org = await getOrgMeta(orgId);
  const employees = await listEmployees(orgId);
  const bindingRows = [];
  for (const e of employees) {
    const binding =
      (await getBinding(e.id)) ??
      (await ensureBindingRow(e.id, e.orgId || org.id));
    bindingRows.push({
      employeeId: e.id,
      displayName: e.displayName,
      roleLabel: e.roleLabel,
      binding,
    });
  }

  return (
    <AppShell
      title="連携"
      subtitle="当社で用意 / 持ち込み · Staffpass（制御）とのつながり"
    >
      <div className="mb-4">
        <McpSetupContent />
      </div>
      <IntegrationsClient
        initialStatus={await getGatewayStatusForOrg(orgId)}
        initialMode={org.integrationMode}
        bindingRows={bindingRows}
      />
      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">Staffpass（制御）の考え方</h2>
        <dl className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs muted">つながりの確認</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              いまつながっているかを確認できます。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">連携の手続き</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              Grok Bot の Plugins（リモート MCP）に Staffpass を登録します。チャットに URL を貼るだけではつながりません。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">実行のルール</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              承認されるまで実行しません。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">社員証</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              AI社員は社員証で本人確認します（接続用の鍵は詳細画面のみ）。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">共有のパソコンでも</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              実行環境が共有でも、職務の分離は社員証・承認・監査で守ります。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">当社で用意する場合</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              接続が切れても記録は消しません。つなぎ直しが必要と表示します。
            </dd>
          </div>
        </dl>
      </section>
    </AppShell>
  );
}
