import { AppShell } from "@/components/AppShell";
import { NotificationChannelsClient } from "@/components/NotificationChannelsClient";
import { getSessionContext } from "@/lib/auth/session";
import { listNotificationChannels } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSessionContext();
  const canManage = session.demo || session.member?.role === "owner" || session.member?.role === "admin";
  const channels = canManage ? await listNotificationChannels(session.orgId) : [];
  return (
    <AppShell title="通知設定" subtitle="組織ごとのTelegram・LINE承認チャネル">
      {canManage ? (
        <>
          <NotificationChannelsClient initialChannels={channels} />
          <p className="mt-4 text-xs faint leading-relaxed">認証情報は暗号化して保存され、画面へ再表示しません。設定変更とテスト送信は監査ログへ記録します。</p>
        </>
      ) : (
        <p className="surface p-4 text-sm">この設定は組織のオーナーまたは管理者のみ変更できます。</p>
      )}
    </AppShell>
  );
}
