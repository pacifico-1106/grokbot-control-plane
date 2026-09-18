import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "漫画でわかるAI社員 — インターン・プロパー・エグゼクティブ | Staffpass",
  description:
    "AI社員の3つのプラン（インターン・プロパー・エグゼクティブ）を漫画で紹介。中小企業がどのようにAI社員を活用し、業務を改善できるかをストーリーで解説します。",
};

const STORIES = [
  {
    slug: "intern",
    title: "インターン",
    subtitle: "定型が回る朝",
    description:
      "日報、議事録、社内案内、予定調整、FAQ対応——定型業務から始めるAI社員活用のストーリー。",
    thumbnail: "/lp/ai-employee/manga/intern/01.png",
    color: "var(--accent-strong)",
  },
  {
    slug: "proper",
    title: "プロパー",
    subtitle: "顧客対応が止まらない",
    description:
      "問い合わせ対応、一次返信、見積整理、商談日程調整——営業の余白を取り戻すストーリー。",
    thumbnail: "/lp/ai-employee/manga/proper/01.png",
    color: "var(--ok)",
  },
  {
    slug: "executive",
    title: "エグゼクティブ",
    subtitle: "経営補佐と開発保守",
    description:
      "週次サマリー、優先度整理、承認ルール設計、開発調査——経営と開発の伴走を描くストーリー。",
    thumbnail: "/lp/ai-employee/manga/executive/01.png",
    color: "var(--warning)",
  },
];

export default function AIEmployeeMangaIndex() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-[640px] px-4 py-3 flex items-center justify-between gap-3">
          <BrandMark size="sm" className="min-w-0" />
          <Link
            href="/lp/ai-employee/consult"
            className="btn btn-primary text-xs py-2 px-3 min-h-[36px]"
          >
            相談する
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-4">
        <section className="pt-8 pb-6 text-center">
          <span className="eyebrow">AI EMPLOYEE MANGA</span>
          <h1 className="mt-4 text-2xl sm:text-3xl font-bold tracking-[-0.045em] leading-tight">
            漫画でわかるAI社員
          </h1>
          <p className="mt-4 text-sm muted leading-relaxed max-w-md mx-auto">
            3つのプラン（インターン・プロパー・エグゼクティブ）で、
            <br className="hidden sm:block" />
            AI社員がどう業務を変えるかをストーリーで紹介します。
          </p>
        </section>

        <section
          aria-label="ストーリー一覧"
          className="grid gap-4 pb-10"
        >
          {STORIES.map((story) => (
            <Link
              key={story.slug}
              href={`/lp/ai-employee/manga/${story.slug}`}
              className="group surface p-0 overflow-hidden hover:border-[var(--accent-strong)] transition-colors"
            >
              <article className="flex flex-col sm:flex-row">
                <div className="relative w-full sm:w-40 aspect-[16/9] sm:aspect-square shrink-0 overflow-hidden">
                  <Image
                    src={story.thumbnail}
                    alt={story.title}
                    fill
                    sizes="(max-width: 640px) 100vw, 160px"
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
                <div className="p-4 sm:p-5 flex flex-col justify-center">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ backgroundColor: story.color }}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-mono uppercase tracking-wider text-[var(--accent-strong)]">
                      {story.slug}
                    </span>
                  </div>
                  <h2 className="mt-2 text-lg font-bold">{story.title}</h2>
                  <p className="text-sm text-[var(--accent-strong)]">
                    {story.subtitle}
                  </p>
                  <p className="mt-2 text-sm muted leading-relaxed line-clamp-2">
                    {story.description}
                  </p>
                  <span className="mt-3 text-xs text-[var(--accent-strong)] group-hover:underline">
                    読む →
                  </span>
                </div>
              </article>
            </Link>
          ))}
        </section>

        <section className="px-0 pb-10">
          <div className="surface p-6 sm:p-8 text-center cta-panel">
            <h2 className="text-xl font-bold tracking-tight">
              AI社員導入パックの詳細へ
            </h2>
            <p className="mt-3 text-sm muted leading-relaxed">
              料金プラン・導入の流れ・よくある質問など、詳しくはAI社員LPをご覧ください。
            </p>
            <div className="mt-6">
              <Link
                href="/lp/ai-employee"
                className="btn btn-primary w-full sm:w-auto justify-center"
              >
                AI社員 導入パック を見る
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
