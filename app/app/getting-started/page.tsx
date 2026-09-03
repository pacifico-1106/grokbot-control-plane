import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { AdminMcpConnect } from "@/components/AdminMcpConnect";
import { OpsDocLocationForm } from "@/components/OpsDocLocationForm";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getOrgAdminAgent } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function GettingStartedPage() {
  const orgId = await getCurrentOrgId();
  const adminAgent = await getOrgAdminAgent(orgId);
  const connected = adminAgent?.status === "linked" && Boolean(adminAgent.grokBotAgentId);
  return (
    <AppShell title="はじめに" subtitle="セットアップ · 毎日の入口は変更ログと承認">
      <div className="space-y-3">
        <section className="surface p-5">
          <p className="text-xs faint font-mono">STEP 01</p>
          <h2 className="mt-2 text-sm font-medium">アカウント</h2>
          <p className="mt-2 text-sm muted leading-relaxed">会社名とメールで Staffpass に入ります。</p>
        </section>

        <AdminMcpConnect connected={connected} grokBotAgentId={adminAgent?.grokBotAgentId ?? null} />

        <section className="surface p-5 space-y-3" id="process-source">
          <p className="text-xs faint font-mono">STEP 03</p>
          <h2 className="text-sm font-medium">工程の正本</h2>
          <p className="text-sm muted leading-relaxed">
            ドキュメントまたは音声またはテキスト。必須はどれか一つです。Drive
            がなくても進めます。会話ログも同じ正本候補です。
          </p>
          <OpsDocLocationForm initial={adminAgent?.opsDocLocation ?? null} />
        </section>

        <section className="surface p-5">
          <p className="text-xs faint font-mono">STEP 04</p>
          <h2 className="mt-2 text-sm font-medium">社員を1人ずつ人確認</h2>
          <p className="mt-2 text-sm muted leading-relaxed">
            管理エージェントが提案した最初の権限案を、人が1人ずつ承認します。毎日の入口ではありません。
          </p>
          <Link href="/app/approvals" className="btn btn-ghost mt-4 text-sm w-full sm:w-auto inline-flex">
            承認へ
          </Link>
        </section>

        <section className="surface p-5">
          <p className="text-xs faint font-mono">STEP 05</p>
          <h2 className="mt-2 text-sm font-medium">手足の紐付け</h2>
          <p className="mt-2 text-sm muted leading-relaxed">
            MCPが案内します。Bot作成はエージェント側。Staffpassは社員証だけを管理します。
          </p>
          <Link href="/app/approvals" className="btn btn-ghost mt-4 text-sm w-full sm:w-auto inline-flex">
            紐付けへ
          </Link>
        </section>

        <section className="surface p-5">
          <p className="text-xs faint font-mono">STEP 06</p>
          <h2 className="mt-2 text-sm font-medium">承認者と通知口</h2>
          <p className="mt-2 text-sm muted leading-relaxed">
            日々の通す／止めるは Telegram / LINE / Slack の通知口が主です。ダッシュボードの承認ボタンは予備です。
          </p>
          <Link href="/app/settings" className="btn btn-ghost mt-4 text-sm w-full sm:w-auto inline-flex">
            通知口
          </Link>
        </section>

        <section className="surface p-5">
          <p className="text-xs faint font-mono">STEP 07</p>
          <h2 className="mt-2 text-sm font-medium">コネクタ認証</h2>
          <p className="mt-2 text-sm muted leading-relaxed">
            Gmail / Slack などの OAuth は人がタップします。承認チケットとは別です。
          </p>
          <Link href="/app/integrations" className="btn btn-ghost mt-4 text-sm w-full sm:w-auto inline-flex">
            連携へ
          </Link>
        </section>

        <section className="surface p-5 space-y-2">
          <h2 className="text-sm font-medium">社員証 MCP は別口</h2>
          <p className="text-sm muted leading-relaxed">
            営業・SNSなどの AI社員は社員証 MCP（whoami / invoke / poll / health）を使います。管理MCPとヘッダを混ぜないでください。
          </p>
          <Link href="/app/integrations#mcp" className="btn btn-ghost mt-2 text-sm w-full sm:w-auto inline-flex">
            社員証 MCP
          </Link>
        </section>
      </div>
    </AppShell>
  );
}
