import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "インターン編 — 定型が回る朝 | AI社員マンガ | Staffpass",
  description:
    "日報・議事録・社内案内・予定調整・FAQ対応。定型業務から始めるAI社員（インターン）活用のストーリーを漫画で紹介。",
};

const PANELS = [
  {
    src: "/lp/ai-employee/manga/intern/01.png",
    alt: "日報と議事録、また社長の夜更かし",
  },
  {
    src: "/lp/ai-employee/manga/intern/02.png",
    alt: "定型はAI社員（インターン）へ",
  },
  {
    src: "/lp/ai-employee/manga/intern/03.png",
    alt: "社内の案内も下書きまで",
  },
  {
    src: "/lp/ai-employee/manga/intern/04.png",
    alt: "予定の空きも確認",
  },
  {
    src: "/lp/ai-employee/manga/intern/05.png",
    alt: "よくある質問に一次案",
  },
  {
    src: "/lp/ai-employee/manga/intern/06.png",
    alt: "インターンから、会社の仕組みに",
  },
];

export default function InternMangaPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-[640px] px-4 py-3 flex items-center justify-between gap-3">
          <BrandMark size="sm" className="min-w-0" />
          <Link
            href="/lp/ai-employee/consult?plan=intern"
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
          <span className="eyebrow block">INTERN</span>
          <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-[-0.045em]">
            インターン編
          </h1>
          <p className="mt-1 text-base text-[var(--accent-strong)]">
            定型が回る朝
          </p>
          <p className="mt-3 text-sm muted leading-relaxed">
            日報・議事録・社内案内・予定調整・FAQ対応。
            <br />
            定型業務から始めるAI社員活用のストーリー。
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
              インターンから、
              <br className="sm:hidden" />
              会社の仕組みに
            </h2>
            <p className="mt-3 text-sm muted leading-relaxed">
              定型業務から始めて、徐々にAI社員を育てていきましょう。
            </p>

            <div className="mt-6 flex flex-col gap-3">
              <Link
                href="/lp/ai-employee/consult?plan=intern"
                className="btn btn-primary w-full justify-center text-base"
              >
                インターンプランで相談する
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
