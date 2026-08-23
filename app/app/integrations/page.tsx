import { AppShell } from "@/components/AppShell";
import { IntegrationsClient } from "@/components/IntegrationsClient";
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
      subtitle="Managed / BYO · Grok Bot ゲートウェイ"
    >
      <IntegrationsClient
        initialStatus={await getGatewayStatusForOrg(orgId)}
        initialMode={org.integrationMode}
        bindingRows={bindingRows}
      />
      <section className="surface p-5 mt-4">
        <h2 className="text-sm font-medium">ゲートウェイ（スリム）</h2>
        <dl className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs muted">Health</dt>
            <dd className="font-mono text-xs mt-1">GET /api/gateway/health</dd>
          </div>
          <div>
            <dt className="text-xs muted">Link</dt>
            <dd className="font-mono text-xs mt-1">POST /api/gateway/link</dd>
          </div>
          <div>
            <dt className="text-xs muted">Invoke（fail-closed）</dt>
            <dd className="font-mono text-xs mt-1">POST /api/gateway/invoke</dd>
          </div>
          <div>
            <dt className="text-xs muted">社員証形式</dt>
            <dd className="font-mono text-xs mt-1">
              Authorization: Bearer gb_emp_…
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">共有ホスト</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              実行環境は共有でも、職務分離は社員証・承認・監査で担保します。
            </dd>
          </div>
          <div>
            <dt className="text-xs muted">Managed 方針</dt>
            <dd className="text-xs muted mt-1 leading-relaxed">
              切断は黙って消さない。needs_reauth で 要再連携。
            </dd>
          </div>
        </dl>
      </section>
    </AppShell>
  );
}
