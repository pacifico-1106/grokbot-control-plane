import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { McpSetupContent } from "@/components/mcp/McpSetupContent";

export const metadata: Metadata = {
  title: "Grok Bot とつなぐ（MCP）— Staffpass",
  description:
    "Staffpass リモート MCP。Grok Bot の Plugins / コネクタに登録します。チャットに URL を貼るだけではつながりません。社員証は雇ったときに一度だけ表示。持ち込みGrok / 運用代行。",
};

export default function PublicMcpDocsPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <header className="mx-auto max-w-5xl px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-[max(1rem,env(safe-area-inset-top))]">
        <BrandMark size="md" className="min-w-0" />
        <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <Link
            href="/login"
            className="btn btn-ghost text-sm min-h-[44px] flex-1 sm:flex-none"
          >
            ログイン
          </Link>
          <Link
            href="/signup"
            className="btn btn-primary text-sm min-h-[44px] flex-1 sm:flex-none"
          >
            トライアル
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 pb-24">
        <div className="pt-6 sm:pt-10 mb-6 max-w-2xl mx-auto min-w-0">
          <p className="chip mb-3">公開ガイド</p>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight leading-snug break-words">
            Grok Bot とつなぐ（MCP）
          </h1>
          <p className="mt-2 text-sm sm:text-base muted leading-relaxed">
            Plugins / コネクタ（リモート MCP）· 持ち込みGrok / 運用代行
          </p>
        </div>
        <div className="mx-auto max-w-2xl min-w-0">
          <McpSetupContent variant="public" />
          <section className="flex flex-col sm:flex-row flex-wrap gap-2 mt-4">
            <Link href="/signup" className="btn btn-primary text-sm min-h-[44px]">
              トライアル
            </Link>
            <Link href="/login" className="btn btn-ghost text-sm min-h-[44px]">
              ログイン
            </Link>
            <Link
              href="/guides/approval-loop"
              className="btn btn-ghost text-sm min-h-[44px]"
            >
              承認ループ運用
            </Link>
          </section>
        </div>
      </main>
    </div>
  );
}
