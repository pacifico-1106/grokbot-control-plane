import Link from "next/link";

/**
 * Shorter path from the top of the page to the 相談 form (LP pattern B).
 * Placement only: these add buttons, they remove or reword no existing content.
 * Server components (no client JS). `href` is built by the caller from fixed paths.
 */
export function HeroConsultCta({ href }: { href: string }) {
  return (
    <div data-testid="lp-hero-consult-cta" className="mx-auto max-w-6xl px-4 sm:px-6 pb-10 sm:pb-12">
      {/* Button sits left of the text on PC so the floating video (bottom-right) never covers it. */}
      <div className="surface flex flex-col sm:flex-row-reverse sm:justify-end items-center gap-3 sm:gap-6 p-4 sm:px-6 sm:py-5 ring-1 ring-[var(--accent-strong)]">
        <p className="text-sm sm:text-base font-semibold text-center sm:text-left">
          導入のご相談・お見積りは、フォームから受け付けています。
        </p>
        <Link href={href} className="btn btn-primary w-full sm:w-auto justify-center shrink-0">
          相談フォームへ進む →
        </Link>
      </div>
    </div>
  );
}

/**
 * Following CTA. Phones: full-width bar fixed to the bottom (same height token as the
 * chat dock, so the floating video lifts above it). PC: a pill at the bottom-left, clear
 * of the floating video at the bottom-right. Rendered only when the chat dock is OFF.
 */
export function StickyConsultCta({ href }: { href: string }) {
  return (
    <>
      <div
        data-testid="lp-sticky-consult-cta"
        className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--lp-chat-dock-h)] items-start border-t border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_88%,transparent)] px-4 pt-2 backdrop-blur-xl sm:inset-x-auto sm:left-6 sm:bottom-6 sm:h-auto sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none"
      >
        <Link
          href={href}
          className="btn btn-primary w-full justify-center sm:w-auto sm:shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        >
          相談フォームへ
        </Link>
      </div>
      {/* keeps the footer reachable above the phone bar */}
      <div aria-hidden="true" className="h-[var(--lp-chat-dock-h)] sm:hidden" />
    </>
  );
}
