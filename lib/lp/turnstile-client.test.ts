import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTurnstileController,
  TURNSTILE_MAX_ERROR_RETRIES,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from "@/lib/lp/turnstile-client";

function fakeTurnstile() {
  const calls: string[] = [];
  const widgets = new Map<string, TurnstileRenderOptions>();
  let n = 0;
  const api: TurnstileApi = {
    render: (_el, opts) => {
      const id = `w${++n}`;
      widgets.set(id, opts);
      calls.push(`render:${id}`);
      return id;
    },
    reset: (id) => calls.push(`reset:${id}`),
    remove: (id) => {
      widgets.delete(id!);
      calls.push(`remove:${id}`);
    },
  };
  const opts = (id = `w${n}`) => widgets.get(id)!;
  return { api, calls, opts };
}

function setup(loaded = true) {
  const t = fakeTurnstile();
  const tokens: Array<string | null> = [];
  const errors: Array<{ errorCode?: string; gaveUp: boolean }> = [];
  let apiLoaded = loaded;
  const ctl = createTurnstileController({
    sitekey: "site",
    getApi: () => (apiLoaded ? t.api : undefined),
    onTokenChange: (tok) => tokens.push(tok),
    onError: (e) => errors.push(e),
  });
  return { ...t, ctl, tokens, errors, load: () => (apiLoaded = true) };
}

const el = () => ({}) as HTMLElement;

describe("Turnstile client token lifecycle", () => {
  test("mount waits for the API, renders once per element with our callbacks", () => {
    const s = setup(false);
    const a = el();
    expect(s.ctl.mount(a)).toBe(false);
    s.load();
    expect(s.ctl.mount(a)).toBe(true);
    expect(s.ctl.mount(a)).toBe(true);
    expect(s.calls).toEqual(["render:w1"]);
    const o = s.opts();
    expect(o.sitekey).toBe("site");
    expect(o.retry).toBe("never");
    expect(typeof o["expired-callback"]).toBe("function");
    expect(typeof o["error-callback"]).toBe("function");
    expect(typeof o["timeout-callback"]).toBe("function");
  });

  test("every start attempt consumes the token: returns it once, clears it, resets the widget", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    expect(s.ctl.token).toBe("tok-1");
    expect(s.ctl.takeToken()).toBe("tok-1");
    expect(s.ctl.token).toBeNull();
    expect(s.tokens).toEqual(["tok-1", null]);
    expect(s.calls).toEqual(["render:w1", "reset:w1"]);
    // A second attempt never re-sends the redeemed token.
    expect(s.ctl.takeToken()).toBeNull();
  });

  test("failed start right after takeToken does not double-reset (challenge already in flight)", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    s.ctl.takeToken();
    s.ctl.reset();
    expect(s.calls).toEqual(["render:w1", "reset:w1"]);
    expect(s.ctl.token).toBeNull();
  });

  test("failed start after a fresh token arrived clears it and resets for a new challenge", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    s.ctl.takeToken();
    s.opts().callback("tok-2"); // fresh token issued while the request was in flight
    s.ctl.reset();
    expect(s.ctl.token).toBeNull();
    expect(s.calls).toEqual(["render:w1", "reset:w1", "reset:w1"]);
    s.opts().callback("tok-3");
    expect(s.ctl.takeToken()).toBe("tok-3");
  });

  test("expired-callback and timeout-callback clear the token and reset the widget", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    s.opts()["expired-callback"]();
    expect(s.ctl.token).toBeNull();
    s.opts().callback("tok-2");
    s.opts()["timeout-callback"]();
    expect(s.ctl.token).toBeNull();
    expect(s.calls).toEqual(["render:w1", "reset:w1", "reset:w1"]);
  });

  test("error-callback clears the token, retries a bounded number of times, then gives up", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    for (let i = 0; i <= TURNSTILE_MAX_ERROR_RETRIES; i++) {
      expect(s.opts()["error-callback"]("600010")).toBe(true);
      expect(s.ctl.token).toBeNull();
    }
    expect(s.calls.filter((c) => c.startsWith("reset:")).length).toBe(TURNSTILE_MAX_ERROR_RETRIES);
    expect(s.errors.map((e) => e.gaveUp)).toEqual([
      ...Array(TURNSTILE_MAX_ERROR_RETRIES).fill(false),
      true,
    ]);
    // A later success resets the retry budget.
    s.opts().callback("tok-2");
    s.opts()["error-callback"]("x");
    expect(s.errors.at(-1)?.gaveUp).toBe(false);
  });

  test("re-mounting on a new element (consent step shown again after a 401) renders a fresh widget", () => {
    const s = setup();
    s.ctl.mount(el());
    s.opts("w1").callback("stale");
    s.ctl.mount(el());
    expect(s.ctl.token).toBeNull();
    expect(s.calls).toEqual(["render:w1", "remove:w1", "render:w2"]);
  });

  test("unmount removes the widget and clears the token; next mount renders again", () => {
    const s = setup();
    const a = el();
    s.ctl.mount(a);
    s.opts().callback("tok-1");
    s.ctl.unmount();
    expect(s.ctl.token).toBeNull();
    s.ctl.mount(a);
    expect(s.calls).toEqual(["render:w1", "remove:w1", "render:w2"]);
  });

  test("API calls that throw do not break the lifecycle", () => {
    const s = setup();
    s.api.reset = () => {
      throw new Error("gone");
    };
    s.ctl.mount(el());
    s.opts().callback("tok-1");
    expect(s.ctl.takeToken()).toBe("tok-1");
    expect(() => s.ctl.reset()).not.toThrow();
  });
});

describe("ChatLauncher wiring", () => {
  const src = readFileSync(join(process.cwd(), "app/lp/ai-employee/ChatLauncher.tsx"), "utf8");

  test("start attempt sends the taken token, and a failed start resets the widget", () => {
    expect(src).toContain("createTurnstileController(");
    expect(src).toMatch(/const attemptToken = ctl \? ctl\.takeToken\(\) : null;/);
    expect(src).toContain("turnstileToken: attemptToken ?? undefined");
    expect(src).toMatch(/if \(!started\) ctl\?\.reset\(\);/);
    expect(src).toContain("ctl.unmount()");
    // No direct render without lifecycle callbacks.
    expect(src).not.toMatch(/window\.turnstile\.render\(/);
  });
});
