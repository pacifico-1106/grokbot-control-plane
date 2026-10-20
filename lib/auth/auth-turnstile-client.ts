/**
 * Two-token Turnstile pair for auth pages.
 *
 * The visitor completes one managed widget. When Supabase Auth CAPTCHA is ON
 * we mint a second, unused token with execution=execute (not shown on load)
 * and never siteverify it — GoTrue redeems it as captchaToken. Cloudflare
 * tokens are single-use; reusing the local siteverify token would fail.
 */
import {
  SUPABASE_AUTH_CAPTCHA_ACTION,
  SUPABASE_AUTH_CAPTCHA_FIELD,
} from "@/lib/auth/supabase-auth-captcha";

export const AUTH_TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const AUTH_TURNSTILE_EXECUTE_TIMEOUT_MS = 15_000;

export interface AuthTurnstileRenderOptions {
  sitekey: string;
  action?: string;
  appearance?: "always" | "execute" | "interaction-only";
  execution?: "render" | "execute";
  language?: string;
  "response-field"?: boolean;
  "response-field-name"?: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "error-callback": (errorCode?: string) => boolean;
  retry: "never" | "auto";
}

export interface AuthTurnstileApi {
  render: (el: HTMLElement, opts: AuthTurnstileRenderOptions) => string | undefined | null;
  reset: (widgetId?: string) => void;
  remove?: (widgetId: string) => void;
  execute?: (widgetId?: string | HTMLElement) => void;
}

export type AuthTurnstileCollectResult =
  | { ok: true; localToken: string; supabaseToken: string }
  | { ok: false; error: "turnstile_required" | "turnstile_failed" };

export interface AuthTurnstilePair {
  mountVisible(el: HTMLElement): boolean;
  mountExecute(el: HTMLElement): boolean;
  collectTokens(): Promise<AuthTurnstileCollectResult>;
  reset(): void;
  unmount(): void;
}

export function createAuthTurnstilePair(options: {
  sitekey: string;
  localAction: string;
  needUnusedSupabase: boolean;
  getApi: () => AuthTurnstileApi | undefined;
  executeTimeoutMs?: number;
}): AuthTurnstilePair {
  const executeTimeoutMs = options.executeTimeoutMs ?? AUTH_TURNSTILE_EXECUTE_TIMEOUT_MS;
  let visibleId: string | null = null;
  let executeId: string | null = null;
  let visibleEl: HTMLElement | null = null;
  let executeEl: HTMLElement | null = null;
  let localToken: string | null = null;
  let pendingExecute: {
    resolve: (token: string) => void;
    reject: (err: Error) => void;
  } | null = null;

  const remove = (id: string | null) => {
    if (!id) return;
    const api = options.getApi();
    if (api?.remove) {
      try {
        api.remove(id);
      } catch {
        // Widget already gone.
      }
    }
  };

  const resetId = (id: string | null) => {
    if (!id) return;
    const api = options.getApi();
    if (!api) return;
    try {
      api.reset(id);
    } catch {
      // ignore
    }
  };

  const settleExecute = (token: string | null, err?: Error) => {
    const pending = pendingExecute;
    pendingExecute = null;
    if (!pending) return;
    if (token) pending.resolve(token);
    else pending.reject(err ?? new Error("turnstile_failed"));
  };

  const renderVisible = (el: HTMLElement): boolean => {
    const api = options.getApi();
    if (!api) return false;
    if (visibleId && visibleEl === el) return true;
    if (visibleId) remove(visibleId);
    localToken = null;
    visibleEl = el;
    visibleId =
      api.render(el, {
        sitekey: options.sitekey,
        action: options.localAction,
        language: "ja",
        retry: "never",
        callback: (t) => {
          localToken = t;
        },
        "expired-callback": () => {
          localToken = null;
        },
        "timeout-callback": () => {
          localToken = null;
        },
        "error-callback": () => {
          localToken = null;
          return true;
        },
      }) ?? null;
    return visibleId !== null;
  };

  const renderExecute = (el: HTMLElement): boolean => {
    if (!options.needUnusedSupabase) return false;
    const api = options.getApi();
    if (!api) return false;
    if (executeId && executeEl === el) return true;
    if (executeId) remove(executeId);
    executeEl = el;
    executeId =
      api.render(el, {
        sitekey: options.sitekey,
        action: SUPABASE_AUTH_CAPTCHA_ACTION,
        execution: "execute",
        appearance: "execute",
        language: "ja",
        "response-field-name": SUPABASE_AUTH_CAPTCHA_FIELD,
        retry: "never",
        callback: (t) => {
          settleExecute(t);
        },
        "expired-callback": () => {
          settleExecute(null, new Error("expired"));
        },
        "timeout-callback": () => {
          settleExecute(null, new Error("timeout"));
        },
        "error-callback": () => {
          settleExecute(null, new Error("error"));
          return true;
        },
      }) ?? null;
    return executeId !== null;
  };

  const executeFresh = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const api = options.getApi();
      if (!api || !executeId || typeof api.execute !== "function") {
        reject(new Error("not_loaded"));
        return;
      }
      resetId(executeId);
      const timer = setTimeout(() => {
        settleExecute(null, new Error("timeout"));
      }, executeTimeoutMs);
      pendingExecute = {
        resolve: (token) => {
          clearTimeout(timer);
          resolve(token);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        api.execute(executeId);
      } catch (err) {
        settleExecute(null, err instanceof Error ? err : new Error("execute"));
      }
    });

  return {
    mountVisible(el) {
      return renderVisible(el);
    },
    mountExecute(el) {
      return renderExecute(el);
    },
    async collectTokens() {
      if (!options.getApi()) return { ok: false, error: "turnstile_failed" };
      const local = (localToken || "").trim();
      if (!local) return { ok: false, error: "turnstile_required" };
      if (!options.needUnusedSupabase) {
        localToken = null;
        resetId(visibleId);
        return { ok: true, localToken: local, supabaseToken: "" };
      }
      if (!executeId) return { ok: false, error: "turnstile_failed" };
      try {
        const unused = (await executeFresh()).trim();
        if (!unused || unused === local) {
          return { ok: false, error: "turnstile_failed" };
        }
        localToken = null;
        resetId(visibleId);
        resetId(executeId);
        return { ok: true, localToken: local, supabaseToken: unused };
      } catch {
        return { ok: false, error: "turnstile_failed" };
      }
    },
    reset() {
      localToken = null;
      settleExecute(null, new Error("reset"));
      resetId(visibleId);
      resetId(executeId);
    },
    unmount() {
      settleExecute(null, new Error("unmount"));
      remove(visibleId);
      remove(executeId);
      visibleId = null;
      executeId = null;
      visibleEl = null;
      executeEl = null;
      localToken = null;
    },
  };
}

export function writeAuthCaptchaFields(
  form: HTMLFormElement,
  tokens: { localToken: string; supabaseToken: string }
): void {
  const write = (name: string, value: string) => {
    if (!value) return;
    let input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  };
  write("cf-turnstile-response", tokens.localToken);
  write(SUPABASE_AUTH_CAPTCHA_FIELD, tokens.supabaseToken);
}
