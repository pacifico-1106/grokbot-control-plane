"use client";

import { useState, type FormEvent } from "react";
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
}: {
  next: string;
  demo: boolean;
  initialEmail: string;
  initialError?: string | null;
  sessionNotice?: boolean;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    initialError ? loginErrorMessage(initialError) : ""
  );
  const [busy, setBusy] = useState(false);

  function showFailure(code?: string | null, status?: number) {
    setPassword("");
    setError(loginErrorMessage(code, status));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ email, password, next }),
      });

      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        if (response.ok) {
          window.location.assign(next || "/app");
          return;
        }
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
        showFailure(body.error, response.status);
        return;
      }

      window.location.assign(body.next || next || "/app");
    } catch {
      showFailure("login_failed");
    } finally {
      setBusy(false);
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
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "サインイン中…" : demo ? "デモでダッシュボードへ" : "ログイン"}
        </button>
      </form>
    </>
  );
}
