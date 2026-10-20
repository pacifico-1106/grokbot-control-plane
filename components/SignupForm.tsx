"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AuthTurnstileFields } from "@/components/AuthTurnstileFields";
import { authSubmitView, beginAuthSubmit, endAuthSubmit } from "@/lib/auth/auth-submit";
import {
  type AuthTurnstilePair,
  writeAuthCaptchaFields,
} from "@/lib/auth/auth-turnstile-client";
import {
  SIGNUP_HONEYPOT_FIELD,
  SIGNUP_ORG_NAME_MAX,
  SIGNUP_TURNSTILE_ACTION,
} from "@/lib/auth/signup-ui";

const TURNSTILE_ERRORS: Record<string, string> = {
  turnstile_required: "ロボットでないことの確認を完了してください。",
  turnstile_failed: "確認に失敗しました。ページを再読み込みしてもう一度お試しください。",
};

export function SignupForm({
  demo,
  siteKey,
  signupClosed,
  supabaseCaptcha,
  closedMessage,
}: {
  demo: boolean;
  siteKey: string | null;
  signupClosed: boolean;
  supabaseCaptcha: boolean;
  closedMessage: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const pairRef = useRef<AuthTurnstilePair | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const needUnusedSupabase = Boolean(siteKey && supabaseCaptcha);
  const button = authSubmitView(busy, "トライアルを開始してダッシュボードへ", "登録中…");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signupClosed) return;
    if (!beginAuthSubmit(lock)) return;
    setBusy(true);
    setError(null);
    try {
      if (siteKey) {
        const tokens = await (pairRef.current?.collectTokens() ??
          Promise.resolve({ ok: false as const, error: "turnstile_failed" as const }));
        if (!tokens.ok) {
          setError(TURNSTILE_ERRORS[tokens.error] || TURNSTILE_ERRORS.turnstile_failed);
          pairRef.current?.reset();
          endAuthSubmit(lock);
          setBusy(false);
          return;
        }
        if (formRef.current) writeAuthCaptchaFields(formRef.current, tokens);
      }
      formRef.current?.submit();
    } catch {
      setError(TURNSTILE_ERRORS.turnstile_failed);
      pairRef.current?.reset();
      endAuthSubmit(lock);
      setBusy(false);
    }
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm">
          {error}
        </p>
      ) : null}
      {signupClosed ? (
        <p role="alert" className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm">
          {closedMessage}
        </p>
      ) : null}
      <form
        ref={formRef}
        action="/api/auth/signup"
        method="post"
        onSubmit={onSubmit}
        className="mt-6 space-y-4"
      >
        <label className="block text-sm">
          <span className="muted">会社名</span>
          <input
            name="orgName"
            required
            maxLength={SIGNUP_ORG_NAME_MAX}
            placeholder="例: 株式会社〇〇"
            autoComplete="organization"
            disabled={busy || signupClosed}
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
            disabled={busy || signupClosed}
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
              disabled={busy || signupClosed}
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
            disabled={busy || signupClosed}
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
            disabled={busy || signupClosed}
            className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
          />
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3 text-xs leading-relaxed muted">
          <input
            name="legal_agreement"
            type="checkbox"
            value="accepted"
            required
            disabled={busy || signupClosed}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-strong)]"
          />
          <span>
            <Link href="/legal/terms" target="_blank" className="underline">
              利用規約
            </Link>
            および
            <Link href="/legal/privacy" target="_blank" className="underline">
              プライバシーポリシー
            </Link>
            に同意し、
            <Link href="/legal/commercial-transactions" target="_blank" className="underline">
              特定商取引法に基づく表記
            </Link>
            を確認しました。
          </span>
        </label>
        <div
          aria-hidden="true"
          style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}
        >
          <label>
            Website
            <input name={SIGNUP_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>
        {siteKey ? (
          <AuthTurnstileFields
            siteKey={siteKey}
            localAction={SIGNUP_TURNSTILE_ACTION}
            needUnusedSupabase={needUnusedSupabase}
            pairRef={pairRef}
          />
        ) : null}
        <button
          type="submit"
          className="btn btn-primary w-full"
          disabled={busy || signupClosed}
          aria-busy={button.ariaBusy}
        >
          {button.label}
        </button>
      </form>
    </>
  );
}
