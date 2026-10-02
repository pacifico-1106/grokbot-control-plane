/**
 * Browser-side Cloudflare Turnstile widget lifecycle for the LP chat launcher.
 *
 * Framework-free so the token lifecycle can be unit tested without a DOM:
 * - a token is single-use (siteverify redeems it) and expires after 300s, so it is
 *   taken (cleared + widget reset) on every start attempt;
 * - a failed start clears the token and resets the widget for a fresh challenge;
 * - expired / timeout clear the token and reset the widget;
 * - error clears the token and retries a bounded number of times (no reset loop
 *   when the challenge keeps failing, e.g. DevTools device emulation);
 * - re-mounting on a new element (consent step shown again after a 401) removes
 *   the old widget and renders a fresh one.
 */

export interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "error-callback": (errorCode?: string) => boolean;
  retry: "never" | "auto";
}

export interface TurnstileApi {
  render: (el: HTMLElement, opts: TurnstileRenderOptions) => string | undefined | null;
  reset: (widgetId?: string) => void;
  remove?: (widgetId: string) => void;
}

export interface TurnstileController {
  /** Render into `el` if the API is loaded. Returns true when a widget is (already) rendered there. */
  mount(el: HTMLElement): boolean;
  /** Consume the current token for one request: returns it, clears it and resets the widget. */
  takeToken(): string | null;
  /** Clear the token and get a fresh challenge (after a failed start). */
  reset(): void;
  /** Remove the widget and clear the token (consent step unmounted / panel closed). */
  unmount(): void;
  readonly token: string | null;
}

export const TURNSTILE_MAX_ERROR_RETRIES = 2;

export function createTurnstileController(options: {
  sitekey: string;
  getApi: () => TurnstileApi | undefined;
  onTokenChange: (token: string | null) => void;
  onError?: (info: { errorCode?: string; gaveUp: boolean }) => void;
  maxErrorRetries?: number;
}): TurnstileController {
  const maxErrorRetries = options.maxErrorRetries ?? TURNSTILE_MAX_ERROR_RETRIES;
  let widgetId: string | null = null;
  let mountedEl: HTMLElement | null = null;
  let token: string | null = null;
  // True from render/reset until the widget issues a token: a reset is already in flight.
  let awaitingToken = false;
  let errorRetries = 0;

  const setToken = (next: string | null) => {
    if (token === next) return;
    token = next;
    options.onTokenChange(next);
  };

  const resetWidget = () => {
    const api = options.getApi();
    if (!api || !widgetId) return;
    awaitingToken = true;
    try {
      api.reset(widgetId);
    } catch {
      // Widget already gone; the next mount renders a new one.
    }
  };

  const removeWidget = () => {
    const api = options.getApi();
    if (api && widgetId && api.remove) {
      try {
        api.remove(widgetId);
      } catch {
        // ignore
      }
    }
    widgetId = null;
    mountedEl = null;
    awaitingToken = false;
  };

  return {
    get token() {
      return token;
    },

    mount(el) {
      const api = options.getApi();
      if (!api) return false;
      if (widgetId && mountedEl === el) return true;
      if (widgetId) removeWidget();
      setToken(null);
      errorRetries = 0;
      awaitingToken = true;
      mountedEl = el;
      widgetId =
        api.render(el, {
          sitekey: options.sitekey,
          retry: "never",
          callback: (t) => {
            awaitingToken = false;
            errorRetries = 0;
            setToken(t);
          },
          "expired-callback": () => {
            setToken(null);
            resetWidget();
          },
          "timeout-callback": () => {
            setToken(null);
            resetWidget();
          },
          "error-callback": (errorCode) => {
            setToken(null);
            awaitingToken = false;
            const gaveUp = errorRetries >= maxErrorRetries;
            if (!gaveUp) {
              errorRetries++;
              resetWidget();
            }
            options.onError?.({ errorCode, gaveUp });
            return true; // handled: do not let Turnstile throw
          },
        }) ?? null;
      return widgetId !== null;
    },

    takeToken() {
      const t = token;
      setToken(null);
      resetWidget();
      return t;
    },

    reset() {
      setToken(null);
      if (!awaitingToken) resetWidget();
    },

    unmount() {
      removeWidget();
      setToken(null);
    },
  };
}
