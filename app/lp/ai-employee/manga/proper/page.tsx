import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "プロパー編 — 顧客対応が止まらない | AI社員マンガ | Staffpass",
  description:
    "問い合わせ対応・一次返信・見積整理・商談日程調整。営業の余白を取り戻すAI社員（プロパー）のストーリーを漫画で紹介。",
};

const PANELS = [
  {
    src: "/lp/ai-employee/manga/proper/01.png",
    alt: "問い合わせが止まらない午後",
  },
  {
    src: "/lp/ai-employee/manga/proper/02.png",
    alt: "一次返信の下書き",
  },
  {
    src: "/lp/ai-employee/manga/proper/03.png",
    alt: "見積メモを整理",
  },
  {
    src: "/lp/ai-employee/manga/proper/04.png",
    alt: "商談の日程候補",
  },
  {
    src: "/lp/ai-employee/manga/proper/05.png",
    alt: "対応ログが日報に",
  },
  {
    src: "/lp/ai-employee/manga/proper/06.png",
    alt: "プロパーで、営業の余白を取り戻す",
  },
];

export default function ProperMangaPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-[640px] px-4 py-3 flex items-center justify-between gap-3">
          <BrandMark size="sm" className="min-w-0" />
          <Link
            href="/lp/ai-employee/consult?plan=proper"
            className="btn btn-primary text-xs py-2 px-3 min-h-[36px]"
          >
            相談する
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-0 sm:px-4">
        <section className="px-4 pt-6 pb-4 text-center">
          <Link
            href="/lp/ai-employee/manga"
            className="inline-flex items-center gap-1 text-xs text-[var(--accent-strong)] hover:underline mb-3"
          >
            ← 漫画一覧
          </Link>
          <span className="eyebrow block">PROPER</span>
          <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-[-0.045em]">
            プロパー編
          </h1>
          <p className="mt-1 text-base text-[var(--accent-strong)]">
            顧客対応が止まらない
          </p>
          <p className="mt-3 text-sm muted leading-relaxed">
            問い合わせ対応・一次返信・見積整理・商談日程調整。
            <br />
            営業の余白を取り戻すAI社員のストーリー。
          </p>
        </section>

        <section aria-label="漫画パネル" className="flex flex-col gap-0">
          {PANELS.map((panel, idx) => (
            <article key={idx} className="relative w-full">
              <Image
                src={panel.src}
                alt={panel.alt}
                width={1080}
                height={1080}
                className="w-full h-auto block"
                priority={idx < 3}
              />
              <span className="sr-only">{panel.alt}</span>
            </article>
          ))}
        </section>

        <section className="px-4 py-10 sm:py-14">
          <div className="surface p-6 sm:p-8 text-center cta-panel">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
              プロパーで、
              <br className="sm:hidden" />
              営業の余白を取り戻す
            </h2>
            <p className="mt-3 text-sm muted leading-relaxed">
              顧客対応に追われる日々から、AI社員と一緒に余白を作りましょう。
            </p>

            <div className="mt-6 flex flex-col gap-3">
              <Link
                href="/lp/ai-employee/consult?plan=proper"
                className="btn btn-primary w-full justify-center text-base"
              >
                プロパープランで相談する
              </Link>
              <Link
                href="/lp/ai-employee#pricing"
                className="btn btn-ghost w-full justify-center text-base"
              >
                料金プランを見る
              </Link>
            </div>

            <div className="mt-6 pt-4 border-t border-[var(--border-soft)]">
              <Link
                href="/lp/ai-employee/manga"
                className="text-sm text-[var(--accent-strong)] hover:underline"
              >
                ← 他のストーリーも読む
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-soft)]">
        <div className="mx-auto max-w-[640px] px-4 py-6 flex flex-col gap-4 text-xs faint">
          <LegalLinks />
          <div className="flex flex-col sm:flex-row justify-between gap-2">
            <span>Staffpass by Sealith</span>
            <span>© TOKYO307</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
