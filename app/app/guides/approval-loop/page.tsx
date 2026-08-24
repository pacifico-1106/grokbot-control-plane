import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { ApprovalLoopContent } from "@/components/guides/ApprovalLoopContent";

export default function ApprovalLoopGuidePage() {
  return (
    <AppShell
      title="承認ループ運用"
      subtitle="署名付き status poll が正本 — Partner webhook まで必須"
    >
      <div className="mx-auto max-w-2xl mb-4 min-w-0">
        <p className="text-sm muted leading-relaxed rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-4 py-3">
          このガイドはログインなしでも読めます。共有用:{" "}
          <Link
            href="/guides/approval-loop"
            className="text-[var(--text)] underline underline-offset-2 hover:opacity-80"
          >
            /guides/approval-loop
          </Link>
        </p>
      </div>
      <ApprovalLoopContent showAppCtas />
    </AppShell>
  );
}
