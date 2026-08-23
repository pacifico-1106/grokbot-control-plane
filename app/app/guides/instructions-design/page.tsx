import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { InstructionsDesignContent } from "@/components/guides/InstructionsDesignContent";

export default function InstructionsDesignGuidePage() {
  return (
    <AppShell
      title="Instructionsの組み立て方"
      subtitle="Base / Role / Skills — 就業規則と日報の書き分け"
    >
      <div className="mx-auto max-w-2xl mb-4 min-w-0">
        <p className="text-sm muted leading-relaxed rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-4 py-3">
          このガイドはログインなしでも読めます。共有用:{" "}
          <Link
            href="/guides/instructions-design"
            className="text-[var(--text)] underline underline-offset-2 hover:opacity-80"
          >
            /guides/instructions-design
          </Link>
        </p>
      </div>
      <InstructionsDesignContent showAppCtas />
    </AppShell>
  );
}
