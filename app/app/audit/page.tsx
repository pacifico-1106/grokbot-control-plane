import { AppShell } from "@/components/AppShell";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import { presentAuditRows } from "@/lib/audit/presentation";
import { getSessionContext } from "@/lib/auth/session";
import { listAuditEvents, listEmployees } from "@/lib/data";
import { hasCapability } from "@/lib/team/rbac";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await getSessionContext();
  const canView = session.demo || hasCapability(session.member, "view_audit");

  if (!canView) {
    return (
      <AppShell
        title="閲覧"
        subtitle="タイムライン — 誰が・何目的で・何をしたか（プロンプト全文ではない）"
      >
        <section className="surface p-8 text-center">
          <p className="text-sm muted">権限がありません。監査ログ閲覧が必要です。</p>
        </section>
      </AppShell>
    );
  }

  const orgId = session.orgId;
  if (!orgId) {
    return (
      <AppShell
        title="閲覧"
        subtitle="タイムライン — 誰が・何目的で・何をしたか（プロンプト全文ではない）"
      >
        <section className="surface p-8 text-center">
          <p className="text-sm muted">まだ監査イベントがありません</p>
        </section>
      </AppShell>
    );
  }

  const [events, employees] = await Promise.all([
    listAuditEvents(orgId),
    listEmployees(orgId),
  ]);
  const employeesById = new Map(
    employees
      .filter((e) => !e.orgId || e.orgId === orgId)
      .map((e) => [e.id, { displayName: e.displayName }])
  );
  const rows = presentAuditRows(
    events.filter((event) => event.orgId === orgId),
    { orgId, employeesById }
  );

  return (
    <AppShell
      title="閲覧"
      subtitle="タイムライン — 誰が・何時に・何をしたか・結果（本文と生データは出しません）"
    >
      {rows.length === 0 ? (
        <section className="surface p-8 text-center">
          <p className="text-sm muted">まだ監査イベントがありません</p>
        </section>
      ) : (
        <AuditTimeline rows={rows} />
      )}
    </AppShell>
  );
}
