import Link from "next/link";

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="法務情報" className={`flex flex-wrap gap-x-4 gap-y-2 ${className}`}>
      <Link href="/legal/terms" className="hover:text-[var(--text)] hover:underline">利用規約</Link>
      <Link href="/legal/privacy" className="hover:text-[var(--text)] hover:underline">プライバシーポリシー</Link>
      <Link href="/legal/commercial-transactions" className="hover:text-[var(--text)] hover:underline">特定商取引法に基づく表記</Link>
    </nav>
  );
}
