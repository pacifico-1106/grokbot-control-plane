/**
 * SIGNUP_RATE_LIMIT_REQUIRED_ENABLED (default OFF).
 * When ON: Layer 2 per-IP / per-mailbox limits are mandatory and fail-closed
 * if the attempt store is missing or unreadable. Welcome / trial mail must
 * not go out. When OFF: today's fail-open Layer 2 is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";

import { isSignupRateLimitRequiredEnabled } from "@/lib/feature-flags";
import {
  evaluateSignupLayer2,
  fingerprintSignup,
  recordSignupAttempt,
  SIGNUP_RATE_LIMITS,
  type SignupAttemptRow,
  type SignupAttemptStore,
} from "./attempts";

const FLAGS = [
  "SIGNUP_ATTEMPT_LOG_ENABLED",
  "SIGNUP_RATE_LIMIT_ENABLED",
  "SIGNUP_DOMAIN_CHECK_ENABLED",
  "SIGNUP_RATE_LIMIT_REQUIRED_ENABLED",
] as const;
const backup = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
beforeEach(() => FLAGS.forEach((f) => delete process.env[f]));
afterEach(() =>
  FLAGS.forEach((f) =>
    backup[f] === undefined ? delete process.env[f] : (process.env[f] = backup[f])
  )
);

function memoryStore(
  rows: Array<SignupAttemptRow & { created_at: string }> = []
): SignupAttemptStore & { rows: typeof rows; fail?: boolean } {
  const store = {
    rows,
    fail: false,
    async insert(row: SignupAttemptRow) {
      if (store.fail) throw new Error("db down");
      rows.push({ ...row, created_at: new Date().toISOString() });
    },
    async count(f: {
      ipHash?: string;
      emailNormHash?: string;
      outcome?: string;
      sinceIso: string;
    }) {
      if (store.fail) throw new Error("db down");
      return rows.filter(
        (r) =>
          r.created_at >= f.sinceIso &&
          (!f.ipHash || r.ip_hash === f.ipHash) &&
          (!f.emailNormHash || r.email_norm_hash === f.emailNormHash) &&
          (!f.outcome || r.outcome === f.outcome)
      ).length;
    },
  };
  return store;
}

function req(headers: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/auth/signup", {
    method: "POST",
    headers,
  });
}

describe("SIGNUP_RATE_LIMIT_REQUIRED_ENABLED flag", () => {
  test("defaults OFF", () => {
    expect(isSignupRateLimitRequiredEnabled()).toBe(false);
  });

  test("accepts true/1/on/enabled", () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    expect(isSignupRateLimitRequiredEnabled()).toBe(true);
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "1";
    expect(isSignupRateLimitRequiredEnabled()).toBe(true);
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "on";
    expect(isSignupRateLimitRequiredEnabled()).toBe(true);
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "enabled";
    expect(isSignupRateLimitRequiredEnabled()).toBe(true);
  });

  test("rejects other values", () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "false";
    expect(isSignupRateLimitRequiredEnabled()).toBe(false);
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "off";
    expect(isSignupRateLimitRequiredEnabled()).toBe(false);
  });
});

describe("flag OFF: today's fail-open Layer 2", () => {
  test("SIGNUP_RATE_LIMIT_ENABLED ON + store error still ok (fail-open)", async () => {
    process.env.SIGNUP_RATE_LIMIT_ENABLED = "true";
    const store = memoryStore();
    store.fail = true;
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    expect((await evaluateSignupLayer2(store, fp)).ok).toBe(true);
  });

  test("store null + rate-limit flag ON still ok (fail-open)", async () => {
    process.env.SIGNUP_RATE_LIMIT_ENABLED = "true";
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    expect((await evaluateSignupLayer2(null, fp)).ok).toBe(true);
  });

  test("recordSignupAttempt skip/failure does not surface when REQUIRED is OFF", async () => {
    const store = memoryStore();
    store.fail = true;
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    const recorded = await recordSignupAttempt(store, fp, "created");
    expect(recorded.ok).toBe(true);
    expect(store.rows.length).toBe(0);
  });
});

describe("flag ON: Layer 2 required, fail-closed, per-IP and per-mailbox", () => {
  test("store unavailable → fail-closed (no mail path)", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    const d = await evaluateSignupLayer2(null, fp);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected fail-closed");
    expect(d.outcome).toBe("rate_limited");
    expect(d.reason).toBe("store_unavailable");
    expect(d.status).toBe(503);
  });

  test("store count error → fail-closed (not fail-open)", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    store.fail = true;
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    const d = await evaluateSignupLayer2(store, fp);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected fail-closed");
    expect(d.reason).toBe("store_unavailable");
    expect(d.status).toBe(503);
  });

  test("applies per-IP limit even when SIGNUP_RATE_LIMIT_ENABLED is OFF", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    const r = req({ "x-real-ip": "198.51.100.8" });
    for (let i = 0; i < SIGNUP_RATE_LIMITS.perIp10m; i++) {
      const fp = fingerprintSignup(r, `u${i}@corp.example`);
      expect((await evaluateSignupLayer2(store, fp)).ok).toBe(true);
      const recorded = await recordSignupAttempt(store, fp, "rejected_guard", {
        reason: "turnstile_required",
      });
      expect(recorded.ok).toBe(true);
    }
    const d = await evaluateSignupLayer2(
      store,
      fingerprintSignup(r, "new@corp.example")
    );
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected rate_limited");
    expect(d.outcome).toBe("rate_limited");
    expect(d.reason).toBe("ip");
    expect(d.status).toBe(429);
  });

  test("applies per-mailbox (recipient) limit", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    const email = "same@corp.example";
    for (let i = 0; i < SIGNUP_RATE_LIMITS.perMailbox24h; i++) {
      const fp = fingerprintSignup(
        req({ "x-real-ip": `198.51.100.${10 + i}` }),
        email
      );
      expect((await evaluateSignupLayer2(store, fp)).ok).toBe(true);
      await recordSignupAttempt(store, fp, "rejected_guard");
    }
    const d = await evaluateSignupLayer2(
      store,
      fingerprintSignup(req({ "x-real-ip": "198.51.100.99" }), email)
    );
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected rate_limited");
    expect(d.outcome).toBe("rate_limited");
    expect(d.reason).toBe("mailbox");
    expect(d.status).toBe(429);
  });

  test("recordSignupAttempt writes even if SIGNUP_ATTEMPT_LOG_ENABLED is OFF", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    const recorded = await recordSignupAttempt(store, fp, "created");
    expect(recorded.ok).toBe(true);
    expect(store.rows.length).toBe(1);
  });

  test("recordSignupAttempt insert failure → ok:false so mail is not sent", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    store.fail = true;
    const fp = fingerprintSignup(req({ "x-real-ip": "198.51.100.4" }), "a@b.example");
    const recorded = await recordSignupAttempt(store, fp, "created");
    expect(recorded.ok).toBe(false);
  });

  test("missing IP hash → fail-closed", async () => {
    process.env.SIGNUP_RATE_LIMIT_REQUIRED_ENABLED = "true";
    const store = memoryStore();
    const fp = fingerprintSignup(req(), "a@b.example");
    expect(fp.ipHash).toBeNull();
    const d = await evaluateSignupLayer2(store, fp);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected fail-closed");
    expect(d.reason).toBe("ip_unavailable");
    expect(d.status).toBe(503);
  });
});
