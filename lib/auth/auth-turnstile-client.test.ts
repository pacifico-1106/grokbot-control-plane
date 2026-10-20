/**
 * Auth pages mint two Turnstile tokens when Supabase Auth CAPTCHA is ON:
 * one user-facing widget (siteverified locally) and one execute-mode widget
 * (unused, forwarded as captchaToken). Tokens are single-use — never reused.
 */
import { describe, expect, test } from "bun:test";
import {
  AUTH_TURNSTILE_EXECUTE_TIMEOUT_MS,
  createAuthTurnstilePair,
  type AuthTurnstileApi,
  type AuthTurnstileRenderOptions,
} from "./auth-turnstile-client";

function fakeTurnstile() {
  const calls: string[] = [];
  const widgets = new Map<string, AuthTurnstileRenderOptions>();
  let n = 0;
  const api: AuthTurnstileApi = {
    render: (_el, opts) => {
      const id = `w${++n}`;
      widgets.set(id, opts);
      calls.push(`render:${id}:${opts.execution ?? "render"}:${opts.action ?? ""}`);
      return id;
    },
    reset: (id) => calls.push(`reset:${id}`),
    remove: (id) => {
      widgets.delete(id!);
      calls.push(`remove:${id}`);
    },
    execute: (id) => calls.push(`execute:${id}`),
  };
  const opts = (id: string) => widgets.get(id)!;
  return { api, calls, opts, widgets };
}

function setup(loaded = true, needUnused = true) {
  const t = fakeTurnstile();
  let apiLoaded = loaded;
  const pair = createAuthTurnstilePair({
    sitekey: "site",
    localAction: "password_reset",
    needUnusedSupabase: needUnused,
    getApi: () => (apiLoaded ? t.api : undefined),
    executeTimeoutMs: 30,
  });
  return { ...t, pair, load: () => (apiLoaded = true) };
}

const el = () => ({}) as HTMLElement;

describe("createAuthTurnstilePair", () => {
  test("visible widget is managed/render; unused widget is execute-mode", () => {
    const s = setup();
    expect(s.pair.mountVisible(el())).toBe(true);
    expect(s.pair.mountExecute(el())).toBe(true);
    const visible = s.opts("w1");
    const unused = s.opts("w2");
    expect(visible.execution ?? "render").toBe("render");
    expect(visible.appearance ?? "always").not.toBe("interaction-only");
    expect(visible.action).toBe("password_reset");
    expect(unused.execution).toBe("execute");
    expect(unused.appearance).toBe("execute");
    expect(unused.action).toBe("supabase_auth");
    expect(unused["response-field-name"]).toBe("cf-turnstile-supabase");
  });

  test("collectTokens returns two distinct tokens and never reuses them", async () => {
    const s = setup();
    s.pair.mountVisible(el());
    s.pair.mountExecute(el());
    s.opts("w1").callback("tok-local-1");
    s.api.execute = (id) => {
      s.calls.push(`execute:${id}`);
      queueMicrotask(() => s.opts("w2").callback("tok-supabase-1"));
    };
    const first = await s.pair.collectTokens();
    expect(first).toEqual({
      ok: true,
      localToken: "tok-local-1",
      supabaseToken: "tok-supabase-1",
    });
    expect(first.ok && first.localToken).not.toBe(first.ok && first.supabaseToken);

    // A second collect must not resend the redeemed tokens.
    s.opts("w1").callback("tok-local-2");
    s.api.execute = (id) => {
      s.calls.push(`execute:${id}`);
      queueMicrotask(() => s.opts("w2").callback("tok-supabase-2"));
    };
    const second = await s.pair.collectTokens();
    expect(second).toEqual({
      ok: true,
      localToken: "tok-local-2",
      supabaseToken: "tok-supabase-2",
    });
    expect(s.calls.filter((c) => c.startsWith("execute:"))).toHaveLength(2);
  });

  test("API not loaded → turnstile_failed (fail-closed, no submit)", async () => {
    const s = setup(false);
    expect(s.pair.mountVisible(el())).toBe(false);
    const r = await s.pair.collectTokens();
    expect(r).toEqual({ ok: false, error: "turnstile_failed" });
  });

  test("no local token → turnstile_required (fail-closed)", async () => {
    const s = setup();
    s.pair.mountVisible(el());
    s.pair.mountExecute(el());
    const r = await s.pair.collectTokens();
    expect(r).toEqual({ ok: false, error: "turnstile_required" });
    expect(s.calls.some((c) => c.startsWith("execute:"))).toBe(false);
  });

  test("execute timeout / missing unused token → turnstile_failed", async () => {
    const s = setup();
    s.pair.mountVisible(el());
    s.pair.mountExecute(el());
    s.opts("w1").callback("tok-local");
    s.api.execute = (id) => {
      s.calls.push(`execute:${id}`);
      // never calls back
    };
    const r = await s.pair.collectTokens();
    expect(r).toEqual({ ok: false, error: "turnstile_failed" });
  });

  test("execute returning the same token as local is rejected (no reuse)", async () => {
    const s = setup();
    s.pair.mountVisible(el());
    s.pair.mountExecute(el());
    s.opts("w1").callback("tok-same");
    s.api.execute = (id) => {
      s.calls.push(`execute:${id}`);
      queueMicrotask(() => s.opts("w2").callback("tok-same"));
    };
    const r = await s.pair.collectTokens();
    expect(r).toEqual({ ok: false, error: "turnstile_failed" });
  });

  test("without unused supabase widget, only the local token is collected", async () => {
    const s = setup(true, false);
    s.pair.mountVisible(el());
    s.opts("w1").callback("tok-only");
    const r = await s.pair.collectTokens();
    expect(r).toEqual({ ok: true, localToken: "tok-only", supabaseToken: "" });
    expect(s.calls.some((c) => c.startsWith("execute:"))).toBe(false);
  });

  test("execute timeout constant is fail-closed, not infinite", () => {
    expect(AUTH_TURNSTILE_EXECUTE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AUTH_TURNSTILE_EXECUTE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });
});
