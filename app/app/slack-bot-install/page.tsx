import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { getSessionContext } from "@/lib/auth/session";
import { listConversationAdapters } from "@/lib/data";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ status?: string; team?: string }>;

const STATUS_MESSAGES: Record<string, { title: string; message: string; ok: boolean }> = {
  ok: {
    title: "インストール完了",
    message: "Slack ワークスペースへのインストールが完了しました。",
    ok: true,
  },
  denied: {
    title: "インストール拒否",
    message: "Slack でインストールが拒否されました。ワークスペース管理者に確認してください。",
    ok: false,
  },
  error_state: {
    title: "認証エラー",
    message: "セッションが無効またはタイムアウトしました。もう一度お試しください。",
    ok: false,
  },
  error_exchange: {
    title: "認可コード交換エラー",
    message: "Slack との認可コード交換に失敗しました。もう一度お試しください。",
    ok: false,
  },
  error_token_type: {
    title: "トークンタイプエラー",
    message: "Bot トークン（xoxb-）を取得できませんでした。Slack アプリの Bot Token Scopes を確認してください。",
    ok: false,
  },
  error_auth: {
    title: "認証テストエラー",
    message: "取得したトークンの検証に失敗しました。もう一度お試しください。",
    ok: false,
  },
  error: {
    title: "エラー",
    message: "予期しないエラーが発生しました。もう一度お試しください。",
    ok: false,
  },
};

export default async function SlackBotInstallPage(props: { searchParams: SearchParams }) {
  const searchParams = await props.searchParams;
  const status = searchParams.status || "";
  const teamName = searchParams.team || "";
  const session = await getSessionContext();
  const adapters = session.orgId ? await listConversationAdapters(session.orgId) : [];
  const slackAdapter = adapters.find((a) => a.surface === "slack");
  const statusInfo = STATUS_MESSAGES[status] || STATUS_MESSAGES.error;

  return (
    <AppShell
      title="Slack インストール"
      subtitle="ワークスペースへの Staffpass アプリインストール"
    >
      {status ? (
        <section className="surface p-6 space-y-4 max-w-xl">
          <div className="flex items-start gap-3">
            <span
              className={`text-2xl ${statusInfo.ok ? "text-green-500" : "text-red-500"}`}
              aria-hidden
            >
              {statusInfo.ok ? "✓" : "✕"}
            </span>
            <div>
              <h2 className="font-semibold text-lg">{statusInfo.title}</h2>
              <p className="text-sm muted mt-1">{statusInfo.message}</p>
              {statusInfo.ok && teamName ? (
                <p className="text-sm mt-2">
                  ワークスペース: <span className="font-medium">{teamName}</span>
                </p>
              ) : null}
            </div>
          </div>
          {statusInfo.ok ? (
            <div className="space-y-3 pt-2 border-t border-[var(--border-soft)]">
              <h3 className="font-medium text-sm">次のステップ</h3>
              <ol className="list-decimal pl-5 space-y-2 text-sm muted">
                <li>
                  Slack ワークスペースで Bot をチャンネルに招待してください
                  <span className="text-xs block mt-0.5">
                    例: /invite @Staffpass
                  </span>
                </li>
                <li>
                  <Link href="/app/settings" className="text-[var(--accent-strong)] hover:underline">
                    つながり設定
                  </Link>
                  でチャンネルを登録してください
                </li>
                <li>AI社員の会話投稿が Bot 名義でチャンネルに送信されます</li>
              </ol>
            </div>
          ) : (
            <div className="pt-2">
              <Link
                href="/api/slack/bot-install/start"
                className="btn btn-primary"
              >
                もう一度試す
              </Link>
            </div>
          )}
        </section>
      ) : (
        <section className="surface p-6 space-y-4 max-w-xl">
          <h2 className="font-semibold">Slack ワークスペースにインストール</h2>
          <p className="text-sm muted leading-relaxed">
            Staffpass アプリを Slack ワークスペースにインストールすると、AI社員が Bot
            名義でチャンネルにメッセージを投稿できるようになります。
          </p>
          {slackAdapter?.enabled ? (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-sm">
              <span className="font-medium">設定済み:</span>{" "}
              {slackAdapter.label || "Slack 会話投稿"}
            </div>
          ) : null}
          <div className="space-y-2">
            <h3 className="font-medium text-sm">Install と Authorize の違い</h3>
            <dl className="text-sm space-y-2">
              <div className="flex gap-2">
                <dt className="font-medium min-w-[5rem]">Install:</dt>
                <dd className="muted">
                  Bot をワークスペースに追加。アプリ管理者が1回実行。
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium min-w-[5rem]">Authorize:</dt>
                <dd className="muted">
                  社員が個人の Slack アカウントを連携。本人名義の投稿に必要。
                </dd>
              </div>
            </dl>
          </div>
          <Link
            href="/api/slack/bot-install/start"
            className="btn btn-primary inline-flex items-center gap-2"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
            </svg>
            Slack ワークスペースにインストール
          </Link>
          <p className="text-xs faint">
            ワークスペースの管理者権限が必要です。インストール後、Bot Token は暗号化して保存されます。
          </p>
        </section>
      )}
      <div className="mt-6">
        <Link href="/app/settings" className="text-sm text-[var(--accent-strong)] hover:underline">
          ← つながり設定に戻る
        </Link>
      </div>
    </AppShell>
  );
}
