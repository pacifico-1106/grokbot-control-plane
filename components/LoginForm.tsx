"use client";

import { useRef, useState, type FormEvent } from "react";
import { AuthTurnstileFields } from "@/components/AuthTurnstileFields";
import { authSubmitView, beginAuthSubmit, endAuthSubmit } from "@/lib/auth/auth-submit";
import { type AuthTurnstilePair } from "@/lib/auth/auth-turnstile-client";
import {
  SESSION_REQUIRED_MESSAGE,
  loginErrorMessage,
} from "@/lib/auth/login-errors";

export function LoginForm({
  next,
  demo,
  initialEmail,
  initialError,
  sessionNotice,
  turnstileSiteKey,
}: {
  next: string;
  demo: boolean;
  initialEmail: string;
  initialError?: string | null;
  sessionNotice?: boolean;
  turnstileSiteKey?: string | null;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    initialError ? loginErrorMessage(initialError) : ""
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const pairRef = useRef<AuthTurnstilePair | null>(null);
  const button = authSubmitView(busy, demo ? "デモでダッシュボードへ" : "ログイン", "サインイン中…");

  function showFailure(code?: string | null, status?: number) {
    setPassword("");
    setError(loginErrorMessage(code, status));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginAuthSubmit(lock)) return;
    setBusy(true);
    setError("");
    let navigating = false;
    try {
      let turnstileToken: string | undefined;
      if (turnstileSiteKey) {
        const tokens = await (pairRef.current?.collectTokens() ??
          Promise.resolve({ ok: false as const, error: "turnstile_failed" as const }));
        if (!tokens.ok) {
          showFailure(tokens.error);
          pairRef.current?.reset();
          return;
        }
        turnstileToken = tokens.localToken;
      }
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          next,
          ...(turnstileToken !== undefined ? { turnstileToken } : {}),
        }),
      });

      if (response.redirected) {
        navigating = true;
        window.location.assign(response.url);
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        if (response.ok) {
          navigating = true;
          window.location.assign(next || "/app");
          return;
        }
        pairRef.current?.reset();
        showFailure(response.status === 429 ? "rate_limited" : "login_failed", response.status);
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        next?: string;
        message?: string;
      };

      if (!response.ok || body.error) {
        pairRef.current?.reset();
        showFailure(body.error, response.status);
        return;
      }

      navigating = true;
      window.location.assign(body.next || next || "/app");
    } catch {
      pairRef.current?.reset();
      showFailure("login_failed");
    } finally {
      if (!navigating) {
        endAuthSubmit(lock);
        setBusy(false);
      }
    }
  }

  return (
    <>
      {sessionNotice ? (
        <p
          className="mt-4 rounded-lg border border-[color-mix(in_oklab,var(--warn)_40%,var(--border))] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--warn)]"
          role="status"
        >
          {SESSION_REQUIRED_MESSAGE}
        </p>
      ) : null}
      {error ? (
        <p
          className="mt-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_40%,var(--border))] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <form
        action="/api/auth/login"
        method="post"
        onSubmit={onSubmit}
        className="mt-6 space-y-4"
      >
        <input type="hidden" name="next" value={next} />
        <label className="block text-sm">
          <span className="muted">メール</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required={!demo}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
          />
        </label>
        <label className="block text-sm">
          <span className="muted">パスワード</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required={!demo}
            minLength={demo ? undefined : 8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
          />
        </label>
        {turnstileSiteKey ? (
          <AuthTurnstileFields
            siteKey={turnstileSiteKey}
            localAction="login"
            needUnusedSupabase={false}
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
