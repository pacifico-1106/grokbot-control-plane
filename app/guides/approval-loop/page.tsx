import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { ApprovalLoopContent } from "@/components/guides/ApprovalLoopContent";

export const metadata: Metadata = {
  title: "承認ループ運用 — Staffpass",
  description:
    "Staffpass↔Grok の署名付き status poll。Partner webhook が来るまで poll 必須。ログイン不要。",
};

export default function PublicApprovalLoopGuidePage() {
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
            承認ループ運用
          </h1>
          <p className="mt-2 text-sm sm:text-base muted leading-relaxed">
            署名付き status poll が正本 — Partner webhook まで必須
          </p>
        </div>
        <ApprovalLoopContent showAppCtas={false} />
      </main>
    </div>
  );
}
