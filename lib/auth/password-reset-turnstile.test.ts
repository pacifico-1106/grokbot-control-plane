import { afterEach, describe, expect, test } from "bun:test";
import { isPasswordResetTurnstileEnabled } from "@/lib/feature-flags";
import {
  evaluatePasswordResetTurnstile,
  type PasswordResetTurnstileDeps,
} from "./password-reset-turnstile";

const FLAG = "PASSWORD_RESET_TURNSTILE_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("PASSWORD_RESET_TURNSTILE_ENABLED", () => {
  test("is OFF by default", () => {
    delete process.env[FLAG];
    expect(isPasswordResetTurnstileEnabled()).toBe(false);
  });

  test("accepts true/1/on/enabled", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", " On "]) {
      process.env[FLAG] = v;
      expect(isPasswordResetTurnstileEnabled()).toBe(true);
    }
  });

  test("rejects other values", () => {
    for (const v of ["false", "0", "off", "random", ""]) {
      process.env[FLAG] = v;
      expect(isPasswordResetTurnstileEnabled()).toBe(false);
    }
  });
});

function deps(over: Partial<PasswordResetTurnstileDeps> & { calls?: string[] } = {}): PasswordResetTurnstileDeps & { calls: string[] } {
  const calls: string[] = over.calls ?? [];
  return {
    calls,
    turnstileConfigured: over.turnstileConfigured ?? (() => true),
    verifyTurnstile:
      over.verifyTurnstile ??
      (async (token: string) => {
        calls.push(token);
        return { success: true, action: "password_reset" };
      }),
  };
}

describe("evaluatePasswordResetTurnstile (flag already ON)", () => {
  test("valid token + action=password_reset passes", async () => {
    const d = deps();
    expect(await evaluatePasswordResetTurnstile({ turnstileToken: "tok" }, d)).toEqual({ ok: true });
    expect(d.calls).toEqual(["tok"]);
  });

  test("keys missing → turnstile_failed, verify never called", async () => {
    const d = deps({ turnstileConfigured: () => false });
    const r = await evaluatePasswordResetTurnstile({ turnstileToken: "tok" }, d);
    expect(r).toEqual({ ok: false, error: "turnstile_failed" });
    expect(d.calls).toEqual([]);
  });

  test("missing / blank token → turnstile_required, verify never called", async () => {
    const d = deps();
    expect(await evaluatePasswordResetTurnstile({ turnstileToken: "" }, d)).toEqual({
      ok: false,
      error: "turnstile_required",
    });
    expect(await evaluatePasswordResetTurnstile({ turnstileToken: "  " }, d)).toEqual({
      ok: false,
      error: "turnstile_required",
    });
    expect(d.calls).toEqual([]);
  });

  test("siteverify failure / not_configured / wrong action → turnstile_failed", async () => {
    expect(
      await evaluatePasswordResetTurnstile(
        { turnstileToken: "tok" },
        deps({ verifyTurnstile: async () => ({ success: false }) })
      )
    ).toEqual({ ok: false, error: "turnstile_failed" });
    expect(
      await evaluatePasswordResetTurnstile(
        { turnstileToken: "tok" },
        deps({ verifyTurnstile: async () => ({ success: true, errorCodes: ["not_configured"] }) })
      )
    ).toEqual({ ok: false, error: "turnstile_failed" });
    expect(
      await evaluatePasswordResetTurnstile(
        { turnstileToken: "tok" },
        deps({ verifyTurnstile: async () => ({ success: true, action: "signup" }) })
      )
    ).toEqual({ ok: false, error: "turnstile_failed" });
  });
});
