import { AppShell } from "@/components/AppShell";
import { ConversationAdaptersClient } from "@/components/ConversationAdaptersClient";
import { NotificationChannelsClient } from "@/components/NotificationChannelsClient";
import { PartyDirectoryClient } from "@/components/PartyDirectoryClient";
import { ProjectsClient } from "@/components/settings/ProjectsClient";
import { SodWarnPolicyClient } from "@/components/settings/SodWarnPolicyClient";
import { getSessionContext } from "@/lib/auth/session";
import {
  getOrgSodWarnPolicy,
  listConversationAdapters,
  listInformationAssets,
  listNotificationChannels,
  listOrgChannels,
  listOrgParties,
  listOrgProjects,
} from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSessionContext();
  const canManage = session.demo || session.member?.role === "owner" || session.member?.role === "admin";
  const channels = canManage ? await listNotificationChannels(session.orgId) : [];
  const adapters = canManage ? await listConversationAdapters(session.orgId) : [];
  const parties = canManage ? await listOrgParties(session.orgId) : [];
  const orgChannels = canManage ? await listOrgChannels(session.orgId) : [];
  const projects = canManage ? await listOrgProjects(session.orgId) : [];
  const assets = canManage ? await listInformationAssets(session.orgId) : [];
  const sodWarnPolicy = canManage ? await getOrgSodWarnPolicy(session.orgId) : null;
  return (
    <AppShell
      title="つながり"
      subtitle="通知口（Telegram / LINE / 承認 Slack）。権限マトリックスではありません。"
    >
      {canManage ? (
        <>
          <section className="surface p-5 space-y-3">
            <h2 className="font-medium">Slack は役割が3つ</h2>
            <p className="text-sm muted leading-relaxed">
              入れる場所を間違えると、「承認は来るが投稿されない」「投稿は出るが社外に機密が漏れる」が起きます。
            </p>
            <ol className="list-decimal pl-5 space-y-2 text-sm leading-relaxed">
              <li>
                <span className="font-medium">人が止める場所</span>
                <span className="muted"> … 承認カードの行き先（Telegram / LINE / Slack）。会話には出ません。</span>
              </li>
              <li>
                <span className="font-medium">社員が書き込む</span>
                <span className="muted"> … 会話投稿。会社のBot名義の xoxb。チャンネルに実メッセージが出ます。本人名義は社員証の Slack 連携です。</span>
              </li>
              <li>
                <span className="font-medium">社内か社外か</span>
                <span className="muted"> … 相手台帳。チャンネル ID を社内 / 社外に分けます。Slack Connect / 社外混在は社内にできません。未登録は社外扱いです。</span>
              </li>
            </ol>
            <p className="text-xs muted leading-relaxed">
              「人が止める」と「社員が書き込む」は、同じ Bot の token を入れて構いません。保存する欄が違うだけです。
            </p>
          </section>
          <NotificationChannelsClient initialChannels={channels} />
          <ConversationAdaptersClient initialAdapters={adapters} />
          <p className="mt-4 text-xs faint leading-relaxed">
            認証情報は暗号化して保存し、画面には再表示しません。変更とテスト送信は記録に残します。
          </p>
          <PartyDirectoryClient initialParties={parties} initialChannels={orgChannels} readOnly />
          {sodWarnPolicy ? <SodWarnPolicyClient initialPolicy={sodWarnPolicy} /> : null}
          <ProjectsClient initialProjects={projects} initialAssets={assets} />
        </>
      ) : (
        <p className="surface p-4 text-sm">この設定は組織のオーナーまたは管理者のみ変更できます。</p>
      )}
    </AppShell>
  );
}
