"use client";

import Link from "next/link";
import { useAppSession } from "@/components/AppSessionProvider";

export function ExpiredTrialBanner() {
  const session = useAppSession();

  if (!session.expiredTrial) {
    return null;
  }

  return (
    <div className="mb-4 rounded-xl border border-[var(--warn,#c9a227)] bg-[var(--warn,#c9a227)]/10 px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--warn,#c9a227)]">
            トライアル期間が終了しました
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            一部の機能（メール送信、日程確定、SNS投稿、購買など）が制限されています。
          </p>
        </div>
        <Link
          href="/app/billing"
          className="btn btn-primary shrink-0 self-start sm:self-center"
        >
          プランを選択
        </Link>
      </div>
    </div>
  );
}
