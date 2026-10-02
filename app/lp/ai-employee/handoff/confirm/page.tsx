import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLpHandoffEnabled } from "@/lib/feature-flags";
import { BrandMark } from "@/components/BrandMark";
import { HandoffConfirmClient } from "./HandoffConfirmClient";

export const metadata: Metadata = {
  title: "相談内容の確認 | Staffpass",
  robots: { index: false, follow: false },
};

// The flag is read per request so this page 404s whenever LP_HANDOFF_ENABLED is OFF.
export const dynamic = "force-dynamic";

export default async function HandoffConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  if (!isLpHandoffEnabled()) notFound();
  const { id } = await searchParams;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) notFound();

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border-soft)]">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <BrandMark size="md" />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-xl font-semibold">担当者への相談内容を確認</h1>
        <p className="text-sm faint mt-2">
          AI相談窓口がまとめた内容です。担当者に共有する前に、内容と連絡先を確認してください。確定するまで共有されません。
        </p>
        <HandoffConfirmClient handoffId={id} />
      </main>
    </div>
  );
}
