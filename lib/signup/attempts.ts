/**
 * Signup attempt log + DB-backed rate limits + domain checks for
 * POST /api/auth/signup. Layer 2 behind the (unflagged) Turnstile hotfix.
 *
 * Flags (all default OFF):
 * - SIGNUP_ATTEMPT_LOG_ENABLED  → write public.signup_attempts rows
 * - SIGNUP_RATE_LIMIT_ENABLED   → per-IP / per-mailbox / global limits (reads the log)
 * - SIGNUP_DOMAIN_CHECK_ENABLED → reject disposable domains, invalid dots, normalized duplicates
 *
 * Rate limiting fails OPEN on DB errors (logged): it is an availability-only
 * control behind fail-closed Turnstile, and must not lock out real signups
 * during a DB incident.
 */
import {
  isSignupAttemptLogEnabled,
  isSignupDomainCheckEnabled,
  isSignupRateLimitEnabled,
} from "@/lib/feature-flags";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { keyedHash, normalizeEmail, type EmailSignal } from "./email-normalize";

export type SignupOutcome =
  | "created"
  | "rejected_guard"
  | "rate_limited"
  | "rejected_domain"
  | "duplicate_normalized"
  | "error";

export type SignupAttemptRow = {
  ip_hash: string | null;
  ua_hash: string | null;
  email_domain: string | null;
  email_norm_hash: string | null;
  outcome: SignupOutcome;
  reason: string | null;
  turnstile_ok: boolean | null;
  honeypot_filled: boolean;
  signals: string[];
  org_id: string | null;
  user_id: string | null;
};

export interface SignupAttemptStore {
  insert(row: SignupAttemptRow): Promise<void>;
  count(filter: {
    ipHash?: string;
    emailNormHash?: string;
    outcome?: SignupOutcome;
    sinceIso: string;
  }): Promise<number>;
}

export const SIGNUP_RATE_LIMITS = {
  perIp10m: 5,
  perIp24h: 20,
  perMailbox24h: 5,
  globalCreated1h: 30,
  duplicateWindowDays: 30,
} as const;

/**
 * Client IP for rate limiting. Prefers headers set by the Vercel edge
 * (x-vercel-forwarded-for / x-real-ip) over client-controllable ones.
 * cf-connecting-ip is deliberately ignored: this app is not behind Cloudflare,
 * so that header is attacker-controlled.
 */
export function trustedClientIp(req: Request): string | null {
  const vercel = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel) return vercel;
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || null;
}

export type SignupFingerprint = {
  ipHash: string | null;
  uaHash: string | null;
  emailDomain: string | null;
  emailNormHash: string | null;
  signals: EmailSignal[];
};

export function fingerprintSignup(req: Request, email: string): SignupFingerprint {
  const ip = trustedClientIp(req);
  const ua = (req.headers.get("user-agent") || "").slice(0, 512);
  const norm = normalizeEmail(email);
  return {
    ipHash: ip ? keyedHash(`ip:${ip}`) : null,
    uaHash: ua ? keyedHash(`ua:${ua}`) : null,
    emailDomain: norm?.domain ?? null,
    emailNormHash: norm ? keyedHash(`em:${norm.normalized}`) : null,
    signals: norm?.signals ?? [],
  };
}

export function anySignupLayer2Enabled(): boolean {
  return isSignupAttemptLogEnabled() || isSignupRateLimitEnabled() || isSignupDomainCheckEnabled();
}

export async function recordSignupAttempt(
  store: SignupAttemptStore | null,
  fp: SignupFingerprint,
  outcome: SignupOutcome,
  extra: { reason?: string | null; turnstileOk?: boolean | null; honeypot?: boolean; orgId?: string | null; userId?: string | null } = {}
): Promise<void> {
  if (!store || !isSignupAttemptLogEnabled()) return;
  const reason = extra.reason ? extra.reason.toLowerCase().replace(/[^a-z0-9_:.-]/g, "_").slice(0, 64) : null;
  try {
    await store.insert({
      ip_hash: fp.ipHash,
      ua_hash: fp.uaHash,
      email_domain: fp.emailDomain,
      email_norm_hash: fp.emailNormHash,
      outcome,
      reason,
      turnstile_ok: extra.turnstileOk ?? null,
      honeypot_filled: extra.honeypot === true,
      signals: fp.signals,
      org_id: extra.orgId ?? null,
      user_id: extra.userId ?? null,
    });
  } catch (e) {
    console.warn("[signup-attempts] insert failed", e instanceof Error ? e.message : "unknown");
  }
}

export type Layer2Decision =
  | { ok: true }
  | { ok: false; outcome: "rate_limited" | "rejected_domain" | "duplicate_normalized"; reason: string; status: number; message: string };

/** Domain check + rate limits. Call after the bot guard, before any side effect. */
export async function evaluateSignupLayer2(
  store: SignupAttemptStore | null,
  fp: SignupFingerprint,
  now: Date = new Date()
): Promise<Layer2Decision> {
  if (isSignupDomainCheckEnabled()) {
    if (fp.signals.includes("disposable_domain")) {
      return { ok: false, outcome: "rejected_domain", reason: "disposable_domain", status: 400,
        message: "このメールアドレスのドメインはご利用いただけません。会社のメールアドレスをお使いください。" };
    }
    if (fp.signals.includes("invalid_dots")) {
      return { ok: false, outcome: "rejected_domain", reason: "invalid_dots", status: 400,
        message: "メールアドレスの形式が正しくありません。" };
    }
    if (store && fp.emailNormHash) {
      try {
        const since = new Date(now.getTime() - SIGNUP_RATE_LIMITS.duplicateWindowDays * 86400000).toISOString();
        const dup = await store.count({ emailNormHash: fp.emailNormHash, outcome: "created", sinceIso: since });
        if (dup > 0) {
          return { ok: false, outcome: "duplicate_normalized", reason: "duplicate_normalized", status: 409,
            message: "このメールアドレスは既に登録されています。ログインしてください。" };
        }
      } catch (e) {
        console.warn("[signup-attempts] duplicate check failed (fail-open)", e instanceof Error ? e.message : "unknown");
      }
    }
  }

  if (isSignupRateLimitEnabled() && store) {
    const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
    try {
      if (fp.ipHash) {
        if ((await store.count({ ipHash: fp.ipHash, sinceIso: iso(10 * 60000) })) >= SIGNUP_RATE_LIMITS.perIp10m ||
            (await store.count({ ipHash: fp.ipHash, sinceIso: iso(86400000) })) >= SIGNUP_RATE_LIMITS.perIp24h) {
          return { ok: false, outcome: "rate_limited", reason: "ip", status: 429,
            message: "短時間に多くの登録がありました。時間をおいて再度お試しください。" };
        }
      }
      if (fp.emailNormHash &&
          (await store.count({ emailNormHash: fp.emailNormHash, sinceIso: iso(86400000) })) >= SIGNUP_RATE_LIMITS.perMailbox24h) {
        return { ok: false, outcome: "rate_limited", reason: "mailbox", status: 429,
          message: "短時間に多くの登録がありました。時間をおいて再度お試しください。" };
      }
      if ((await store.count({ outcome: "created", sinceIso: iso(3600000) })) >= SIGNUP_RATE_LIMITS.globalCreated1h) {
        return { ok: false, outcome: "rate_limited", reason: "global", status: 429,
          message: "現在登録が混み合っています。時間をおいて再度お試しください。" };
      }
    } catch (e) {
      console.warn("[signup-attempts] rate limit check failed (fail-open)", e instanceof Error ? e.message : "unknown");
    }
  }
  return { ok: true };
}

/** Supabase-backed store (service role). Null in DEMO / unconfigured. */
export function createSupabaseSignupAttemptStore(): SignupAttemptStore | null {
  let admin: ReturnType<typeof createSupabaseAdminClient> = null;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) return null;
  return {
    async insert(row) {
      const { error } = await admin.from("signup_attempts").insert(row);
      if (error) throw new Error(error.message);
    },
    async count(filter) {
      let q = admin.from("signup_attempts").select("id", { count: "exact", head: true }).gte("created_at", filter.sinceIso);
      if (filter.ipHash) q = q.eq("ip_hash", filter.ipHash);
      if (filter.emailNormHash) q = q.eq("email_norm_hash", filter.emailNormHash);
      if (filter.outcome) q = q.eq("outcome", filter.outcome);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  };
}
