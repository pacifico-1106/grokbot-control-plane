import { AppShell } from "@/components/AppShell";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import { loadAuditPresentationLookups } from "@/lib/audit/lookups";
import { presentAuditRows } from "@/lib/audit/presentation";
import type { AuditPageSearchInput } from "@/lib/audit/page-query";
import { getSessionContext } from "@/lib/auth/session";
import { listAuditEvents, queryAuditPageEvents } from "@/lib/data";
import { isAuditPageFilterPageEnabledForOrg } from "@/lib/feature-flags";
import { hasCapability } from "@/lib/team/rbac";

export const dynamic = "force-dynamic";

function firstString(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function nextPageHref(input: AuditPageSearchInput, cursor: string): string {
  const params = new URLSearchParams();
  const action = firstString(input.action).trim();
  const from = firstString(input.from).trim();
  const to = firstString(input.to).trim();
  const result = firstString(input.result).trim();
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (result) params.set("result", result);
  params.set("cursor", cursor);
  return `/app/audit?${params.toString()}`;
}

function AuditFilterForm({
  input,
  nextCursor,
}: {
  input: AuditPageSearchInput;
  nextCursor: string | null;
}) {
  const action = firstString(input.action);
  const from = firstString(input.from);
  const to = firstString(input.to);
  const result = firstString(input.result);
  const nextHref = nextCursor ? nextPageHref(input, nextCursor) : null;
  return (
    <form method="get" action="/app/audit" className="surface p-4 mb-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-xs muted block">
          操作
          <input
            name="action"
            defaultValue={action}
            autoComplete="off"
            className="mt-1 w-full bg-transparent border border-[var(--border)] rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs muted block">
          開始日
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="mt-1 w-full bg-transparent border border-[var(--border)] rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs muted block">
          終了日
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="mt-1 w-full bg-transparent border border-[var(--border)] rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs muted block">
          結果
          <select
            name="result"
            defaultValue={result}
            className="mt-1 w-full bg-transparent border border-[var(--border)] rounded px-2 py-1 text-sm"
          >
            <option value="">すべて</option>
            <option value="success">成功</option>
            <option value="failure">失敗</option>
            <option value="denied">拒否</option>
            <option value="pending">待ち</option>
            <option value="unknown">不明</option>
          </select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="chip">
          絞り込む
        </button>
        {nextHref ? (
          <a href={nextHref} className="text-sm">
            次のページ
          </a>
        ) : null}
      </div>
    </form>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<AuditPageSearchInput>;
} = {}) {
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

  const raw = (await searchParams) ?? {};
  const filterOn = isAuditPageFilterPageEnabledForOrg(orgId);
  const queried = filterOn
    ? await queryAuditPageEvents(orgId, raw)
    : { events: await listAuditEvents(orgId), nextCursor: null };
  const events = queried.events.filter((event) => event.orgId === orgId);
  const lookups = await loadAuditPresentationLookups(orgId, events);
  const rows = presentAuditRows(events, lookups);

  return (
    <AppShell
      title="閲覧"
      subtitle="タイムライン — 誰が・何時に・何をしたか・結果（本文と生データは出しません）"
    >
      {filterOn ? <AuditFilterForm input={raw} nextCursor={queried.nextCursor} /> : null}
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
