import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

export const metadata: Metadata = {
  title: "便利なのに、説明できない — ChatGPTだけでは足りない理由 | Staffpass",
  description:
    "AIの便利さだけでは会社の説明責任を果たせない。Staffpass（AI社員の社員証）とSealith（機密ファイルの転送便）で、境界と記録を残す方法を漫画で解説。",
};

const PANELS = [
  { src: "/lp/manga/01.png", alt: "便利なのに、説明できない — ChatGPTだけでは足りない理由" },
  { src: "/lp/manga/02.png", alt: "社員が契約書をAIに貼った — あとから誰が渡したか分からない" },
  { src: "/lp/manga/03.png", alt: "なぜChatGPT・Claude・Geminiだけでは会社の現場でうまくいかないのか？ — 社員証がない、会社の承認が残らない、ファイルの止め方がない" },
  { src: "/lp/manga/04.png", alt: "StaffpassはAI社員の社員証 — Slack連携、承認スタンプ、監査台帳" },
  { src: "/lp/manga/05.png", alt: "Sealithは機密ファイルの転送便 — シール（ロック）、開封・閲覧、取り消し、目的・期限" },
  { src: "/lp/manga/06.png", alt: "片方だけでも、両方でも成り立つ — AIが最適解を出し、境界が信頼を保証する" },
  { src: "/lp/manga/07.png", alt: "中小企業の社長が変わったポイントまとめ — 社員証で説明できる、転送便で止められる、ChatGPT単体の不安が会社の仕組みに" },
  { src: "/lp/manga/08.png", alt: "はじめの一歩で、未来は大きく変わる — StaffpassアカウントとSealithアカウントの開設CTA" },
];

export default function MangaLP() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-[640px] px-4 py-3 flex items-center justify-between gap-3">
          <BrandMark size="sm" className="min-w-0" />
          <Link href="/signup" className="btn btn-primary text-xs py-2 px-3 min-h-[36px]">
            無料で試す
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-0 sm:px-4">
        <section className="px-4 pt-6 pb-4 text-center">
          <h1 className="sr-only">便利なのに、説明できない — ChatGPTだけでは足りない理由</h1>
          <p className="text-sm muted leading-relaxed">
            中小企業の経営者が気づいた、AIの「便利さ」だけでは足りない理由。
          </p>
        </section>

        <section aria-label="漫画パネル" className="flex flex-col gap-0">
          {PANELS.map((panel, idx) => (
            <article key={idx} className="relative w-full">
              <Image
                src={panel.src}
                alt={panel.alt}
                width={1080}
                height={1170}
                className="w-full h-auto block"
                priority={idx < 3}
              />
            </article>
          ))}
        </section>

        <section className="px-4 py-10 sm:py-14">
          <div className="surface p-6 sm:p-8 text-center cta-panel">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
              はじめの一歩で、<br className="sm:hidden" />未来は大きく変わる
            </h2>
            <p className="mt-3 text-sm muted leading-relaxed">
              まずは小さく、会社の境界から。
            </p>

            <div className="mt-6 flex flex-col gap-3">
              <Link
                href="/signup"
                className="btn btn-primary w-full justify-center text-base"
              >
                <span className="inline-flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Staffpassアカウントを開設
                </span>
              </Link>

              <Link
                href="https://www.sealith.com/lp/ai-information-management"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost w-full justify-center text-base border-[color-mix(in_oklab,var(--accent-strong)_30%,var(--border))] hover:border-[color-mix(in_oklab,var(--accent-strong)_50%,var(--border))]"
              >
                <span className="inline-flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Sealithアカウントを開設
                </span>
              </Link>
            </div>

            <p className="mt-5 text-xs faint">
              小さな一歩が、大きな信頼につながります。
            </p>
          </div>
        </section>

        <section className="px-4 pb-10">
          <details className="group surface p-4 sm:p-5">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
              <span className="text-sm font-semibold">StaffpassとSealithの違いは？</span>
              <span className="mt-0.5 shrink-0 font-mono text-xs text-[var(--accent-strong)]" aria-hidden="true">
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">−</span>
              </span>
            </summary>
            <div className="mt-3 text-sm muted leading-relaxed space-y-2">
              <p>
                <strong className="text-[var(--text)]">Staffpass</strong>はAI社員の社員証です。誰が、何の目的で、どこまで実行できるかを管理し、承認と監査を残します。
              </p>
              <p>
                <strong className="text-[var(--text)]">Sealith</strong>は機密ファイルの転送便です。ブラウザ内で暗号化し、誰に・何の目的で・いつまで渡すかを限って、あとから共有を止められます。
              </p>
              <p>
                中小企業の多くはStaffpassだけで足ります。契約書や顧客名簿などをAIに触らせるときだけSealithを足します。
              </p>
            </div>
          </details>
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
