import { BrandMark } from "@/components/BrandMark";

export const dynamic = "force-dynamic";

/**
 * Invited Auth user without an active org membership (invite revoked, member
 * suspended, or invited before the membership row was created). We never
 * auto-provision a brand-new org for invited users.
 */
export default function NoAccessPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight">アクセス権がありません</h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          このアカウントは招待済みですが、有効な組織メンバーシップがありません。招待した管理者にメンバー登録の状態を確認してもらってください。
        </p>
        <form method="post" action="/api/auth/logout" className="mt-6">
          <button type="submit" className="btn w-full">
            ログアウト
          </button>
        </form>
      </div>
    </div>
  );
}
