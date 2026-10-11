import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// IP_HASH_KEY is required (no dev fallback); fixture key for this test process.
process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";
import {
  evaluateSignupLayer2,
  fingerprintSignup,
  recordSignupAttempt,
  trustedClientIp,
  SIGNUP_RATE_LIMITS,
  type SignupAttemptRow,
  type SignupAttemptStore,
} from "./attempts";

const FLAGS = ["SIGNUP_ATTEMPT_LOG_ENABLED", "SIGNUP_RATE_LIMIT_ENABLED", "SIGNUP_DOMAIN_CHECK_ENABLED"] as const;
const backup = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
beforeEach(() => FLAGS.forEach((f) => delete process.env[f]));
afterEach(() => FLAGS.forEach((f) => (backup[f] === undefined ? delete process.env[f] : (process.env[f] = backup[f]))));

function memoryStore(rows: Array<SignupAttemptRow & { created_at: string }> = []): SignupAttemptStore & { rows: typeof rows; fail?: boolean } {
  const store = {
    rows,
    fail: false,
    async insert(row: SignupAttemptRow) {
      if (store.fail) throw new Error("db down");
      rows.push({ ...row, created_at: new Date().toISOString() });
    },
    async count(f: { ipHash?: string; emailNormHash?: string; outcome?: string; sinceIso: string }) {
      if (store.fail) throw new Error("db down");
      return rows.filter((r) => r.created_at >= f.sinceIso && (!f.ipHash || r.ip_hash === f.ipHash) &&
        (!f.emailNormHash || r.email_norm_hash === f.emailNormHash) && (!f.outcome || r.outcome === f.outcome)).length;
    },
  };
  return store;
}

function req(headers: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/auth/signup", { method: "POST", headers });
}

describe("flags default OFF", () => {
  test("no write, no limit when all flags OFF", async () => {
    const store = memoryStore();
    const fp = fingerprintSignup(req({ "x-real-ip": "203.0.113.1" }), "x@mailinator.com");
    await recordSignupAttempt(store, fp, "created");
    expect(store.rows.length).toBe(0);
    expect((await evaluateSignupLayer2(store, fp)).ok).toBe(true);
  });
});

describe("trusted client IP", () => {
  test("ignores attacker-controlled cf-connecting-ip, prefers Vercel header", () => {
    expect(trustedClientIp(req({ "cf-connecting-ip": "1.1.1.1", "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "9.9.9.9" }))).toBe("203.0.113.7");
    expect(trustedClientIp(req({ "cf-connecting-ip": "1.1.1.1" }))).toBeNull();
  });
});

describe("attempt log", () => {
  test("stores only hashes + domain + signals", async () => {
    process.env.SIGNUP_ATTEMPT_LOG_ENABLED = "true";
    const store = memoryStore();
    const fp = fingerprintSignup(req({ "x-real-ip": "203.0.113.1", "user-agent": "bot/1.0" }), "Sop.Uxap.E9.05@gmail.com");
    await recordSignupAttempt(store, fp, "rejected_guard", { reason: "Turnstile Failed!" });
    const row = store.rows[0];
    expect(row.email_domain).toBe("gmail.com");
    expect(row.reason).toBe("turnstile_failed_");
    expect(row.signals).toContain("gmail_dot_trick");
    expect(JSON.stringify(row)).not.toContain("203.0.113.1");
    expect(JSON.stringify(row)).not.toContain("sop");
  });
  test("insert failure never throws", async () => {
    process.env.SIGNUP_ATTEMPT_LOG_ENABLED = "true";
    const store = memoryStore();
    store.fail = true;
    await recordSignupAttempt(store, fingerprintSignup(req(), "a@b.example"), "created");
  });
});

describe("rate limits", () => {
  test("per-IP 10 minute limit", async () => {
    process.env.SIGNUP_ATTEMPT_LOG_ENABLED = "true";
    process.env.SIGNUP_RATE_LIMIT_ENABLED = "true";
    const store = memoryStore();
    const r = req({ "x-real-ip": "198.51.100.4" });
    for (let i = 0; i < SIGNUP_RATE_LIMITS.perIp10m; i++) {
      const fp = fingerprintSignup(r, `u${i}@corp.example`);
      expect((await evaluateSignupLayer2(store, fp)).ok).toBe(true);
      await recordSignupAttempt(store, fp, "rejected_guard", { reason: "turnstile_required" });
    }
    const d = await evaluateSignupLayer2(store, fingerprintSignup(r, "new@corp.example"));
    expect(d.ok === false && d.outcome).toBe("rate_limited");
  });
  test("DB error fails open", async () => {
    process.env.SIGNUP_RATE_LIMIT_ENABLED = "true";
    const store = memoryStore();
    store.fail = true;
    expect((await evaluateSignupLayer2(store, fingerprintSignup(req({ "x-real-ip": "1.2.3.4" }), "a@b.example"))).ok).toBe(true);
  });
});

describe("domain check", () => {
  test("disposable / invalid dots / normalized duplicate", async () => {
    process.env.SIGNUP_DOMAIN_CHECK_ENABLED = "true";
    process.env.SIGNUP_ATTEMPT_LOG_ENABLED = "true";
    const store = memoryStore();
    const d1 = await evaluateSignupLayer2(store, fingerprintSignup(req(), "x@yopmail.com"));
    expect(d1.ok === false && d1.reason).toBe("disposable_domain");
    const d2 = await evaluateSignupLayer2(store, fingerprintSignup(req(), "d.u..n@gmail.com"));
    expect(d2.ok === false && d2.reason).toBe("invalid_dots");
    await recordSignupAttempt(store, fingerprintSignup(req(), "sopuxape905@gmail.com"), "created");
    const d3 = await evaluateSignupLayer2(store, fingerprintSignup(req(), "sop.uxap.e9.05@gmail.com"));
    expect(d3.ok === false && d3.outcome).toBe("duplicate_normalized");
    expect((await evaluateSignupLayer2(store, fingerprintSignup(req(), "real.person@corp.example"))).ok).toBe(true);
  });
});
