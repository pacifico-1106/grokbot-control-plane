import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { isDemoMode } from "@/lib/mode";
import { LegalLinks } from "@/components/LegalLinks";
import Script from "next/script";
import {
  SIGNUP_HONEYPOT_FIELD,
  SIGNUP_ORG_NAME_MAX,
  SIGNUP_TURNSTILE_ACTION,
} from "@/lib/auth/signup-guard";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** Fixed messages keyed by error code — never echo request input back into the page. */
const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  signup_rejected: "登録を受け付けられませんでした。時間をおいて再度お試しください。",
  invalid_org_name: "会社名を正しく入力してください（サンプルの会社名は使えません・100文字以内）。",
  invalid_referral_code: "紹介コードは AIC-XXXX の形式で入力してください（不明な場合は空欄）。",
  bot_protection_unavailable: "現在、新規登録を一時停止しています。お問い合わせフォームからご連絡ください。",
  turnstile_required: "ロボットでないことの確認を完了してください。",
  turnstile_failed: "確認に失敗しました。ページを再読み込みしてもう一度お試しください。",
};

function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  if (!key || key.startsWith("replace_me")) return null;
  return key;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const demo = isDemoMode();
  const sp = (await searchParams) ?? {};
  const errorMessage = sp.error ? SIGNUP_ERROR_MESSAGES[sp.error] ?? null : null;
  const siteKey = demo ? null : turnstileSiteKey();
  const signupClosed = !demo && !siteKey;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
      <div className="w-full max-w-md surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">無料トライアル · 14日</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          AI社員を雇い始める
        </h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          {demo
            ? "デモモードです。設定がなくてもダッシュボードへ進めます。本番では会社アカウントと管理者を作成します。"
            : "登録後はダッシュボードへ。会社アカウントを作成し、ウェルカムメールをお送りします。"}
        </p>
        {errorMessage ? (
          <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm">
            {errorMessage}
          </p>
        ) : null}
        {signupClosed ? (
          <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm">
            {SIGNUP_ERROR_MESSAGES.bot_protection_unavailable}
          </p>
        ) : null}
        {siteKey ? <Script src={TURNSTILE_SCRIPT_SRC} strategy="afterInteractive" /> : null}
        <form action="/api/auth/signup" method="post" className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="muted">会社名</span>
            <input
              name="orgName"
              required
              maxLength={SIGNUP_ORG_NAME_MAX}
              placeholder="例: 株式会社〇〇"
              autoComplete="organization"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="block text-sm">
            <span className="muted">メール</span>
            <input
              name="email"
              type="email"
              required
              defaultValue={demo ? "owner@example.com" : ""}
              placeholder={demo ? undefined : "you@company.com"}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          {!demo ? (
            <label className="block text-sm">
              <span className="muted">パスワード（8文字以上）</span>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
              />
            </label>
          ) : (
            <input type="hidden" name="password" value="demo-not-used" />
          )}
          <label className="block text-sm">
            <span className="muted">導入モード</span>
            <select
              name="mode"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm"
              defaultValue="managed"
            >
              <option value="managed">おまかせ導入（こちらで Grok Bot を用意）</option>
              <option value="byo">今の Grok Bot に載せる（持ち込み）</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="muted">紹介コード（任意）</span>
            <input
              name="referral_code"
              type="text"
              placeholder="AIC-XXXX"
              autoComplete="off"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>
          <label className="flex items-start gap-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3 text-xs leading-relaxed muted">
            <input name="legal_agreement" type="checkbox" value="accepted" required className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-strong)]" />
            <span>
              <Link href="/legal/terms" target="_blank" className="underline">利用規約</Link>および
              <Link href="/legal/privacy" target="_blank" className="underline">プライバシーポリシー</Link>に同意し、
              <Link href="/legal/commercial-transactions" target="_blank" className="underline">特定商取引法に基づく表記</Link>を確認しました。
            </span>
          </label>
          {/* Honeypot: hidden from humans and assistive tech; bots that fill every field are rejected. */}
          <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
            <label>
              Website
              <input name={SIGNUP_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </label>
          </div>
          {siteKey ? (
            <div
              className="cf-turnstile"
              data-sitekey={siteKey}
              data-action={SIGNUP_TURNSTILE_ACTION}
              data-language="ja"
            />
          ) : null}
          <button type="submit" className="btn btn-primary w-full" disabled={signupClosed}>
            トライアルを開始してダッシュボードへ
          </button>
        </form>
        <ol className="mt-5 space-y-1 text-xs faint list-decimal list-inside">
          <li>ダッシュボードを開く</li>
          <li>はじめに のチェックリスト</li>
          <li>AI社員を雇う</li>
        </ol>
        <p className="mt-4 text-xs faint">
          すでにアカウントがある方は{" "}
          <Link href="/login" className="underline">
            ログイン
          </Link>
          {" · "}
          <Link href="/app" className="underline">
            ダッシュボード
          </Link>
        </p>
        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}
