import { describe, expect, test } from "bun:test";
import {
  evaluateSignupGuard,
  parseReferralCode,
  validateSignupOrgName,
  type SignupGuardDeps,
  type SignupGuardInput,
} from "./signup-guard";

const base: SignupGuardInput = {
  orgName: "株式会社テスト",
  referralCode: "",
  honeypot: "",
  turnstileToken: "tok",
  clientIp: "203.0.113.5",
  demo: false,
};

function deps(over: Partial<SignupGuardDeps> & { calls?: string[] } = {}): SignupGuardDeps & { calls: string[] } {
  const calls: string[] = over.calls ?? [];
  return {
    calls,
    turnstileConfigured: over.turnstileConfigured ?? (() => true),
    verifyTurnstile:
      over.verifyTurnstile ??
      (async (token: string) => {
        calls.push(token);
        return { success: true, action: "signup" };
      }),
  };
}

describe("signup guard: Turnstile fail-closed (non-demo)", () => {
  test("valid token + action=signup passes and normalizes fields", async () => {
    const d = deps();
    const r = await evaluateSignupGuard({ ...base, orgName: "  株式会社テスト ", referralCode: "aic-ab12" }, d);
    expect(r).toEqual({ ok: true, orgName: "株式会社テスト", referralCode: "AIC-AB12" });
    expect(d.calls).toEqual(["tok"]);
  });

  test("keys missing → 503, verify never called", async () => {
    const d = deps({ turnstileConfigured: () => false });
    const r = await evaluateSignupGuard(base, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toBe("bot_protection_unavailable");
    }
    expect(d.calls).toEqual([]);
  });

  test("missing token → 400 turnstile_required", async () => {
    const r = await evaluateSignupGuard({ ...base, turnstileToken: " " }, deps());
    expect(r.ok === false && r.error).toBe("turnstile_required");
  });

  test("siteverify failure → 403", async () => {
    const r = await evaluateSignupGuard(base, deps({ verifyTurnstile: async () => ({ success: false, errorCodes: ["invalid-input-response"] }) }));
    expect(r.ok === false && r.status).toBe(403);
  });

  test("helper fail-open result (not_configured) is treated as failure", async () => {
    const r = await evaluateSignupGuard(base, deps({ verifyTurnstile: async () => ({ success: true, errorCodes: ["not_configured"] }) }));
    expect(r.ok === false && r.error).toBe("turnstile_failed");
  });

  test("token minted for another widget action (e.g. LP chat) is rejected", async () => {
    const r = await evaluateSignupGuard(base, deps({ verifyTurnstile: async () => ({ success: true, action: "" }) }));
    expect(r.ok === false && r.error).toBe("turnstile_failed");
  });

  test("demo mode skips Turnstile (no real accounts) but keeps other checks", async () => {
    const d = deps({ turnstileConfigured: () => false });
    expect((await evaluateSignupGuard({ ...base, demo: true, turnstileToken: "" }, d)).ok).toBe(true);
    expect((await evaluateSignupGuard({ ...base, demo: true, honeypot: "x" }, d)).ok).toBe(false);
  });
});

describe("signup guard: honeypot / referral / org name (observed bot pattern)", () => {
  test("filled honeypot rejected before Turnstile is consulted", async () => {
    const d = deps();
    const r = await evaluateSignupGuard({ ...base, honeypot: "http://spam.example" }, d);
    expect(r.ok === false && r.error).toBe("signup_rejected");
    expect(d.calls).toEqual([]);
  });

  test("random uppercase referral codes from the 2026-09 bot are rejected", async () => {
    for (const code of ["OYTHXCTQOIWWDOQSQRBFD", "FANLQLODAKFZTXUM", "LXPERWFUNGXSCJMWV"]) {
      const r = await evaluateSignupGuard({ ...base, referralCode: code }, deps());
      expect(r.ok === false && r.error).toBe("invalid_referral_code");
    }
  });

  test("referral parsing", () => {
    expect(parseReferralCode("")).toBeNull();
    expect(parseReferralCode(" aic-xy9z ")).toBe("AIC-XY9Z");
    expect(parseReferralCode("AIC-1")).toBe("invalid");
    expect(parseReferralCode("AIC-ABCD<script>")).toBe("invalid");
  });

  test("demo placeholder company name is rejected", async () => {
    const r = await evaluateSignupGuard({ ...base, orgName: "株式会社サンプル商事" }, deps());
    expect(r.ok === false && r.error).toBe("invalid_org_name");
  });

  test("org name length / control chars / empty", () => {
    expect(validateSignupOrgName("").ok).toBe(false);
    expect(validateSignupOrgName("a".repeat(101)).ok).toBe(false);
    expect(validateSignupOrgName("Acme\r\nBcc: x@example.com").ok).toBe(false);
    expect(validateSignupOrgName("Ａｃｍｅ 株式会社")).toEqual({ ok: true, value: "Acme 株式会社" });
  });
});
