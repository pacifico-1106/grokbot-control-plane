/**
 * Signup with IP_HASH_KEY missing: clear 503 (JSON) / redirect with a fixed error code (HTML form),
 * before the guard, attempt log, referral write or any email. Same shape as #302.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const sideEffects: string[] = [];
mock.module("@/lib/email", () => ({
  sendWelcomeEmail: async () => { sideEffects.push("welcome_email"); return { ok: true }; },
  sendTrialStartedEmail: async () => { sideEffects.push("trial_email"); return { ok: true }; },
}));
mock.module("@/lib/data/org-context", () => ({
  setOrgReferralCodeIfEmpty: async () => { sideEffects.push("referral"); },
}));

const ENV = ["IP_HASH_KEY"];
const backup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

const route = await import("@/app/api/auth/signup/route");

beforeEach(() => {
  sideEffects.length = 0;
  delete process.env.IP_HASH_KEY;
});

const jsonReq = () =>
  new Request("https://x.example/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", "user-agent": "ua" },
    body: JSON.stringify({ orgName: "テスト株式会社", email: "owner@corp.example.jp", password: "Passw0rd!long", legalAgreement: true }),
  });

describe("signup: IP_HASH_KEY missing → refused before any side effect", () => {
  for (const value of [undefined, "", "replace_me_x", "default_hash_key_for_dev"]) {
    test(`JSON → 503 signup_unavailable (key=${JSON.stringify(value)})`, async () => {
      if (value !== undefined) process.env.IP_HASH_KEY = value;
      const res = await route.POST(jsonReq());
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("signup_unavailable");
      expect(body.message.length).toBeGreaterThan(0);
      expect(sideEffects).toEqual([]);
    });
  }

  test("HTML form → 303 to /signup?error=signup_unavailable (fixed code), no side effect", async () => {
    const form = new FormData();
    form.set("orgName", "テスト株式会社");
    form.set("email", "owner@corp.example.jp");
    form.set("password", "Passw0rd!long");
    form.set("legal_agreement", "accepted");
    const res = await route.POST(new Request("https://x.example/api/auth/signup", { method: "POST", body: form }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") || "").searchParams.get("error")).toBe("signup_unavailable");
    expect(sideEffects).toEqual([]);
  });

  test("signup page has a fixed message for signup_unavailable", () => {
    const src = readFileSync(path.join(process.cwd(), "app/signup/page.tsx"), "utf8");
    expect(src).toMatch(/signup_unavailable:\s*"/);
  });

  test("key set → not 503 (unchanged)", async () => {
    process.env.IP_HASH_KEY = "signup-test-ip-hash-key-0123456789";
    const res = await route.POST(jsonReq());
    expect(res.status).not.toBe(503);
  });
});
