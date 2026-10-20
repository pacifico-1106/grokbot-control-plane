"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthTurnstileFields } from "@/components/AuthTurnstileFields";
import { PASSWORD_RESET_SENT_MESSAGE, PASSWORD_RESET_TURNSTILE_ACTION } from "@/lib/auth/password-reset-ui";
import {
  authFieldLock,
  authSubmitStillMounted,
  authSubmitView,
  beginAuthSubmit,
  endAuthSubmit,
  finishNativeAuthSubmit,
} from "@/lib/auth/auth-submit";
import {
  type AuthTurnstilePair,
  writeAuthCaptchaFields,
} from "@/lib/auth/auth-turnstile-client";
import { SUPABASE_AUTH_CAPTCHA_ACTION } from "@/lib/auth/supabase-auth-captcha";

const ERRORS: Record<string, string> = {
  email_invalid: "メールアドレスの形式を確認してください",
  rate_limited: "しばらく待ってから再度お試しください",
  link_invalid:
    "リンクが無効か有効期限切れです。下のフォームから再設定メールを再送するか、招待者に再招待を依頼してください",
  turnstile_required: "ロボットでないことの確認を完了してください",
  turnstile_failed: "確認に失敗しました。ページを再読み込みしてもう一度お試しください。",
};

export function ForgotPasswordForm({
  siteKey,
  localTurnstile,
  supabaseCaptcha,
  initialSent,
  initialError,
}: {
  siteKey: string | null;
  localTurnstile: boolean;
  supabaseCaptcha: boolean;
  initialSent: boolean;
  initialError: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const lock = useRef(false);
  const mounted = useRef(true);
  const pairRef = useRef<AuthTurnstilePair | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const needUnusedSupabase = Boolean(siteKey && localTurnstile && supabaseCaptcha);
  const localAction = localTurnstile ? PASSWORD_RESET_TURNSTILE_ACTION : SUPABASE_AUTH_CAPTCHA_ACTION;
  const button = authSubmitView(busy, "再設定メールを送信", "送信中…");

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginAuthSubmit(lock)) return;
    setBusy(true);
    setError(null);
    try {
      if (siteKey) {
        const tokens = await (pairRef.current?.collectTokens() ??
          Promise.resolve({ ok: false as const, error: "turnstile_failed" as const }));
        if (!tokens.ok) {
          setError(ERRORS[tokens.error] || ERRORS.turnstile_failed);
          pairRef.current?.reset();
          endAuthSubmit(lock);
          setBusy(false);
          return;
        }
        if (!authSubmitStillMounted(mounted, lock)) {
          setBusy(false);
          return;
        }
        if (formRef.current) writeAuthCaptchaFields(formRef.current, tokens);
      }
      if (!authSubmitStillMounted(mounted, lock)) {
        setBusy(false);
        return;
      }
      if (!finishNativeAuthSubmit(formRef.current, lock)) {
        setBusy(false);
      }
    } catch {
      setError(ERRORS.turnstile_failed);
      pairRef.current?.reset();
      endAuthSubmit(lock);
      setBusy(false);
    }
  }

  if (initialSent) {
    return <p className="mt-4 text-sm muted leading-relaxed">{PASSWORD_RESET_SENT_MESSAGE}</p>;
  }

  return (
    <>
      <p className="mt-3 text-sm muted leading-relaxed">
        登録済みのメールアドレスを入力してください。再設定用のリンクをお送りします。
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {error}
        </p>
      ) : null}
      <form
        ref={formRef}
        method="post"
        action="/api/auth/forgot-password"
        onSubmit={onSubmit}
        className="mt-6 space-y-4"
      >
        <label className="block text-sm">
          <span className="muted">メール</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            {...authFieldLock(busy)}
            className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
          />
        </label>
        {siteKey ? (
          <AuthTurnstileFields
            siteKey={siteKey}
            localAction={localAction}
            needUnusedSupabase={needUnusedSupabase}
            pairRef={pairRef}
          />
        ) : null}
        <button type="submit" className="btn btn-primary w-full" disabled={busy} aria-busy={button.ariaBusy}>
          {button.label}
        </button>
      </form>
    </>
  );
}
