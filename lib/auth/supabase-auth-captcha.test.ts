/**
 * SUPABASE_AUTH_CAPTCHA_ENABLED (default OFF): pass an unused Turnstile token
 * to GoTrue as captchaToken. Tokens are single-use (Cloudflare siteverify
 * redeems them), so a token we already verified must never be forwarded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isSupabaseAuthCaptchaEnabled } from "@/lib/feature-flags";
import {
  passwordResetEmailOptions,
  passwordSignInCredentials,
  readAuthCaptchaFields,
  unusedCaptchaTokenForSupabase,
} from "./supabase-auth-captcha";

const FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("SUPABASE_AUTH_CAPTCHA_ENABLED", () => {
  test("is OFF by default", () => {
    delete process.env[FLAG];
    expect(isSupabaseAuthCaptchaEnabled()).toBe(false);
  });

  test("accepts true/1/on/enabled", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE", " On "]) {
      process.env[FLAG] = v;
      expect(isSupabaseAuthCaptchaEnabled()).toBe(true);
    }
  });

  test("rejects other values", () => {
    for (const v of ["false", "0", "off", "random", ""]) {
      process.env[FLAG] = v;
      expect(isSupabaseAuthCaptchaEnabled()).toBe(false);
    }
  });
});

describe("passwordSignInCredentials", () => {
  test("omits options entirely when no token (flag-OFF / main shape)", () => {
    const creds = passwordSignInCredentials("a@b.co", "secret", undefined);
    expect(creds).toEqual({ email: "a@b.co", password: "secret" });
    expect("options" in creds).toBe(false);
  });

  test("blank token is treated as absent (never send empty captchaToken)", () => {
    const creds = passwordSignInCredentials("a@b.co", "secret", "   ");
    expect(creds).toEqual({ email: "a@b.co", password: "secret" });
    expect("options" in creds).toBe(false);
  });

  test("non-empty token → options.captchaToken", () => {
    expect(passwordSignInCredentials("a@b.co", "secret", "tok-1")).toEqual({
      email: "a@b.co",
      password: "secret",
      options: { captchaToken: "tok-1" },
    });
  });
});

describe("passwordResetEmailOptions", () => {
  test("omits captchaToken when absent (flag-OFF / main shape)", () => {
    const opts = passwordResetEmailOptions("https://example.com/auth/confirm", undefined);
    expect(opts).toEqual({ redirectTo: "https://example.com/auth/confirm" });
    expect(Object.keys(opts)).toEqual(["redirectTo"]);
  });

  test("blank token is treated as absent", () => {
    const opts = passwordResetEmailOptions("https://example.com/auth/confirm", "  ");
    expect(Object.keys(opts)).toEqual(["redirectTo"]);
  });

  test("non-empty token sits on the same options object as redirectTo", () => {
    expect(passwordResetEmailOptions("https://example.com/auth/confirm", "tok-2")).toEqual({
      redirectTo: "https://example.com/auth/confirm",
      captchaToken: "tok-2",
    });
  });
});

describe("readAuthCaptchaFields", () => {
  test("JSON body: local + dedicated supabase fields", () => {
    expect(
      readAuthCaptchaFields({
        turnstileToken: " local-json ",
        supabaseCaptchaToken: " sb-json ",
      })
    ).toEqual({ localToken: "local-json", supabaseToken: "sb-json" });
  });

  test("JSON body: implicit Turnstile field names", () => {
    expect(
      readAuthCaptchaFields({
        "cf-turnstile-response": "local-cf",
        "cf-turnstile-supabase": "sb-cf",
      })
    ).toEqual({ localToken: "local-cf", supabaseToken: "sb-cf" });
  });

  test("FormData uses the same field names", () => {
    const form = new FormData();
    form.set("cf-turnstile-response", "local-form");
    form.set("cf-turnstile-supabase", "sb-form");
    expect(readAuthCaptchaFields(form)).toEqual({
      localToken: "local-form",
      supabaseToken: "sb-form",
    });
  });

  test("empty / missing → empty strings, never null", () => {
    expect(readAuthCaptchaFields({})).toEqual({ localToken: "", supabaseToken: "" });
  });
});

describe("unusedCaptchaTokenForSupabase", () => {
  test("when we did not siteverify, the local field may be reused", () => {
    expect(
      unusedCaptchaTokenForSupabase({
        localToken: "only-one",
        supabaseToken: "",
        localTokenSiteverified: false,
      })
    ).toBe("only-one");
  });

  test("dedicated field wins even when we did not siteverify", () => {
    expect(
      unusedCaptchaTokenForSupabase({
        localToken: "local",
        supabaseToken: "dedicated",
        localTokenSiteverified: false,
      })
    ).toBe("dedicated");
  });

  test("when we already siteverified, the local field must not be forwarded", () => {
    expect(
      unusedCaptchaTokenForSupabase({
        localToken: "consumed",
        supabaseToken: "",
        localTokenSiteverified: true,
      })
    ).toBe("");
  });

  test("when we already siteverified, a distinct dedicated token is forwarded", () => {
    expect(
      unusedCaptchaTokenForSupabase({
        localToken: "consumed",
        supabaseToken: "fresh",
        localTokenSiteverified: true,
      })
    ).toBe("fresh");
  });

  test("identical tokens are unusable after local siteverify (single-use)", () => {
    expect(
      unusedCaptchaTokenForSupabase({
        localToken: "same",
        supabaseToken: "same",
        localTokenSiteverified: true,
      })
    ).toBe("");
  });
});
