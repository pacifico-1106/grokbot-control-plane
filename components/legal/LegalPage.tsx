import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";
import type { LegalIdentity } from "@/lib/legal";

export function LegalPage({
  title,
  description,
  identity,
  children,
}: {
  title: string;
  description: string;
  identity: LegalIdentity;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border-soft)]">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <BrandMark size="sm" href="/" />
          <Link href="/signup" className="btn btn-primary px-4 text-xs">無料で試す</Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="eyebrow">LEGAL</p>
        <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed muted">{description}</p>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs faint">
          <span>制定・施行日: {identity.effectiveDate}</span>
          <span>最終改定日: {identity.effectiveDate}</span>
        </div>

        {!identity.configured ? (
          <aside className="mt-6 rounded-2xl border border-[color-mix(in_oklab,var(--warn)_45%,var(--border))] bg-[color-mix(in_oklab,var(--warn)_8%,transparent)] p-4 text-sm leading-relaxed">
            <strong className="text-[var(--warn)]">運営者情報の開示について</strong>
            <p className="mt-2 muted">
              電話番号は、ご請求があり次第、申込みの意思決定前に確認できるよう遅滞なく電子メールで開示します。
              開示請求は <a href={`mailto:${identity.contactEmail}`} className="underline">{identity.contactEmail}</a> までご連絡ください。
            </p>
          </aside>
        ) : null}

        <article className="legal-copy mt-10">{children}</article>
      </main>
      <footer className="border-t border-[var(--border-soft)]">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-7 text-xs faint sm:px-6">
          <LegalLinks />
          <div className="flex flex-col justify-between gap-2 sm:flex-row"><span>Staffpass by Sealith</span><span>© TOKYO307</span></div>
        </div>
      </footer>
    </div>
  );
}

export function LegalArticle({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
