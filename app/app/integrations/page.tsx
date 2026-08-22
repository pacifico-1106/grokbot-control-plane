import { AppShell } from "@/components/AppShell";
import { IntegrationsClient } from "@/components/IntegrationsClient";
import { DEMO_ORG, getGatewayStatus } from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export default function IntegrationsPage() {
  return (
    <AppShell
      title="連携"
      subtitle="Managed / BYO · Grok Bot ゲートウェイ"
    >
      <IntegrationsClient
        initialStatus={getGatewayStatus()}
        initialMode={DEMO_ORG.integrationMode}
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
        </dl>
      </section>
    </AppShell>
  );
}
