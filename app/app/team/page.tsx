import { AppShell } from "@/components/AppShell";
import { TeamClient } from "@/components/TeamClient";
import { DEMO_ORG, getRuntimeMembers } from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export default function TeamPage() {
  const members = getRuntimeMembers();

  return (
    <AppShell
      title="チーム"
      subtitle={`${DEMO_ORG.name} · 職務＋権限フラグ（admin一択ではない）`}
    >
      <p className="mb-4 text-sm muted leading-relaxed max-w-3xl">
        人間メンバーは「経営・営業・経理…」の職務と、承認・雇い・請求などの権限フラグで分けます。
        AI社員の社員証とは別レイヤです。デモでは API に{" "}
        <code className="text-xs">x-member-id</code> を付けると権限チェックが効きます。
      </p>
      <TeamClient initialMembers={members} />
      <section className="surface p-5 mt-4 space-y-2">
        <h2 className="text-sm font-medium">権限の考え方（短く）</h2>
        <ul className="text-xs muted space-y-1 leading-relaxed">
          <li>· 職務チップでパック適用 → チェックで微調整（閲覧のみショートカットあり）</li>
          <li>· 承認キューは approve_actions、雇い・発行は hire_issue_credentials</li>
          <li>· 請求は manage_billing（経営寄り）。粗い owner/admin 席は互換用</li>
        </ul>
      </section>
    </AppShell>
  );
}
