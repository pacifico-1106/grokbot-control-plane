import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { InstructionsDesignContent } from "@/components/guides/InstructionsDesignContent";

export const metadata: Metadata = {
  title: "Instructionsの組み立て方 — Staffpass",
  description:
    "Base / Role / Skills。就業規則と日報の書き分け。ログイン不要の公開ガイド。",
};

export default function PublicInstructionsDesignGuidePage() {
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
            Instructionsの組み立て方
          </h1>
          <p className="mt-2 text-sm sm:text-base muted leading-relaxed">
            Base / Role / Skills — 就業規則と日報の書き分け
          </p>
        </div>
        <InstructionsDesignContent showAppCtas={false} />
      </main>
    </div>
  );
}
