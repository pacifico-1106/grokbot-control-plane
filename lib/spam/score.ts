/**
 * Spam scoring for tenant signups (pure; no I/O). Mirrors the signals that
 * identified the 2026-09 「株式会社サンプル商事」 bot wave (spam-sample-20261003).
 *
 * Bands: >= 70 candidate (report + proposal ticket), 40–69 watch, else ok.
 */
import { DEMO_ORG } from "@/lib/demo-data";
import { normalizeEmail } from "@/lib/signup/email-normalize";

export const SPAM_CANDIDATE_THRESHOLD = 70;
export const SPAM_WATCH_THRESHOLD = 40;

export type SpamFacts = {
  orgId: string;
  orgName: string;
  orgCreatedAt: string;
  referralCode: string | null;
  stripeCustomerId: string | null;
  hasStripeSubscription: boolean;
  memberCount: number;
  employeeCount: number;
  sameName24h: number;
  ownerMemberId: string | null;
  ownerUserId: string | null;
  ownerMemberStatus: string | null;
  ownerEmail: string | null;
  userCreatedAt: string | null;
  lastSignInAt: string | null;
  bannedUntil: string | null;
  signupSignals: string[];
  signupIpReuse: number;
};

export type SpamSignal = { code: string; points: number };
export type SpamScore = { score: number; band: "candidate" | "watch" | "ok"; signals: SpamSignal[] };

const DEFAULT_ORG_NAMES = new Set([DEMO_ORG.name, "新しい組織"]);

export function scoreSpamFacts(f: SpamFacts, now: Date = new Date()): SpamScore {
  const signals: SpamSignal[] = [];
  const add = (code: string, points: number) => signals.push({ code, points });

  if (DEFAULT_ORG_NAMES.has((f.orgName || "").trim())) add("default_org_name", 40);
  const ref = (f.referralCode || "").trim();
  if (ref && !/^AIC-[A-Z0-9]{4,16}$/.test(ref)) {
    add("referral_not_aic", 40);
    if (/^[A-Z]{12,}$/.test(ref)) add("referral_random_upper", 10);
  }

  const norm = f.ownerEmail ? normalizeEmail(f.ownerEmail) : null;
  const emailSignals = new Set<string>([...(norm?.signals ?? []), ...(f.signupSignals ?? [])]);
  if (emailSignals.has("gmail_dot_trick") || emailSignals.has("invalid_dots")) add("email_dot_trick", 10);
  if (emailSignals.has("disposable_domain")) add("disposable_domain", 30);

  if (f.userCreatedAt && f.lastSignInAt) {
    const created = Date.parse(f.userCreatedAt);
    const last = Date.parse(f.lastSignInAt);
    if (Number.isFinite(created) && Number.isFinite(last) && last - created < 5000 && now.getTime() - created > 86400000) {
      add("never_returned", 5);
    }
  }
  if (f.employeeCount === 0 && !f.stripeCustomerId && f.memberCount <= 1) add("empty_tenant", 5);
  if (f.sameName24h >= 3) add("same_name_burst", 10);
  if (f.signupIpReuse >= 3) add("signup_ip_reuse", 15);

  // Hard negatives: paying or active tenants are never candidates.
  if (f.stripeCustomerId || f.hasStripeSubscription) add("has_billing", -100);
  if (f.employeeCount > 0) add("has_ai_employees", -50);

  const score = Math.max(0, Math.min(100, signals.reduce((s, x) => s + x.points, 0)));
  const band = score >= SPAM_CANDIDATE_THRESHOLD ? "candidate" : score >= SPAM_WATCH_THRESHOLD ? "watch" : "ok";
  return { score, band, signals };
}

/** "so***5@gmail.com" — never put full addresses into reports or tool output. */
export function maskEmail(email: string | null | undefined): string {
  const e = (email || "").trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  const tail = local.length > 4 ? local.slice(-1) : "";
  return `${head}***${tail}@${domain}`;
}
