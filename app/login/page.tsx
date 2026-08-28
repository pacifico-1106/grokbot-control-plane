import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { LoginForm } from "@/components/LoginForm";
import { LegalLinks } from "@/components/LegalLinks";
import { isSessionNotice } from "@/lib/auth/login-errors";
import { isDemoMode } from "@/lib/mode";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    error?: string;
    email?: string;
    reason?: string;
    expired?: string;
  }>;
}) {
  const sp = await searchParams;
  const next = sp.next || "/app";
  const demo = isDemoMode();
  const initialEmail = sp.email || (demo ? "owner@example.com" : "");
  const sessionNotice = isSessionNotice(sp.reason) || sp.expired === "1";

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">ログイン</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          管理画面
        </h1>
        {demo ? (
          <p className="mt-3 text-sm muted leading-relaxed">
            デモモード（Supabase キー未設定）。そのままダッシュボードを開けます。キーを入れた後は本番ログインが有効になります。
          </p>
        ) : (
          <p className="mt-3 text-sm muted leading-relaxed">
            登録済みのメールとパスワードでサインインしてください。
          </p>
        )}
        <LoginForm
          next={next}
          demo={demo}
          initialEmail={initialEmail}
          initialError={sp.error}
          sessionNotice={sessionNotice}
        />
        <p className="mt-4 text-xs faint">
          アカウント未作成の方は{" "}
          <Link href="/signup" className="underline">
            トライアル登録
          </Link>
        </p>
        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
