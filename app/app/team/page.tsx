import { AppShell } from "@/components/AppShell";
import { TeamClient } from "@/components/TeamClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getOrgMeta, listMembers } from "@/lib/data";
import {
  guardActorFromMember,
  resolveMemberChangeActor,
} from "@/lib/team/apply-member-change";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const orgId = await getCurrentOrgId();
  const members = await listMembers(orgId);
  const org = await getOrgMeta(orgId);
  // Checkbox state only (server re-checks every POST). Actor = session member.
  const who = await resolveMemberChangeActor(null).catch(() => null);
  const viewerRow = who?.ok ? members.find((m) => m.id === who.actor.id) ?? null : null;
  const viewer = viewerRow && who?.ok ? guardActorFromMember(viewerRow, who.authEmail) : null;

  return (
    <AppShell
      title="チーム"
      subtitle={`${org.name} · 職務と権限を分けて設定`}
    >
      <p className="mb-4 text-sm muted leading-relaxed max-w-3xl">
        人間のメンバーは「経営・営業・経理…」の職務と、承認・雇い・請求などの権限で分けます。
        AI社員の社員証とは別の設定です。
      </p>
      <TeamClient initialMembers={members} viewer={viewer} />
      <section className="surface p-5 mt-4 space-y-2">
        <h2 className="text-sm font-medium">権限の考え方（短く）</h2>
        <ul className="text-xs muted space-y-1 leading-relaxed">
          <li>· 職務を選ぶと権限のセットが入ります。あとからチェックで微調整できます（閲覧のみもあります）。</li>
          <li>· 承認キューを触る人、AI社員を雇う人、請求を見る人を分けられます。</li>
          <li>· 請求は経営寄りの権限です。ざっくりした「管理者」席も残しています。</li>
          <li>· 「承認キュー」「請求・契約」「予算上限の管理」の付与・解除と、オーナー席の付与・解除はオーナーだけができます。</li>
          <li>· 自分自身の権限や席種別は上げられません（オーナーも同じ）。最後のオーナーは外せません。</li>
        </ul>
      </section>
    </AppShell>
  );
}
