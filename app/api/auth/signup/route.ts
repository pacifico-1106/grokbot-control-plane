import { NextResponse } from "next/server";
import {
  createOrgWithOwner,
  provisionOrgForUser,
} from "@/lib/auth/session";
import { evaluateSignupGuard, SIGNUP_HONEYPOT_FIELD } from "@/lib/auth/signup-guard";
import {
  anySignupLayer2Enabled,
  createSupabaseSignupAttemptStore,
  evaluateSignupLayer2,
  fingerprintSignup,
  recordSignupAttempt,
} from "@/lib/signup/attempts";
import { setOrgReferralCodeIfEmpty } from "@/lib/data/org-context";
import { DEMO_ORG } from "@/lib/demo-data";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { getClientIp, getTurnstileConfig, verifyTurnstileToken } from "@/lib/lp/turnstile";
import { isDemoMode } from "@/lib/mode";
import { isIpHashKeyConfigured } from "@/lib/security/ip-hash-key";
import { TRIAL_DAYS } from "@/lib/stripe";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const runtime = "nodejs";

async function establishSession(email: string, password: string) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (
          cookiesToSet: {
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }[]
        ) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options as never);
          });
        },
      },
    }
  );
  return supabase.auth.signInWithPassword({ email, password });
}

/**
 * Production signup: auth user + org + owner member, then session cookie.
 * DEMO: redirect to /app (no hard crash).
 *
 * Recovery:
 * - If Auth user was created but org insert failed previously (`email_exists`
 *   or `auth_ok_org_failed`), sign-in + provisionOrgForUser finishes the job.
 * - User can also login → /app (auto-provision) or POST/GET /api/auth/repair-org.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  let orgName = "";
  let email = "";
  let password = "";
  let mode = "managed";
  let displayName = "";
  let referralCode = "";
  let legalAgreement = false;
  let honeypot = "";
  let turnstileToken = "";

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    orgName = String(body.orgName || "").trim();
    email = String(body.email || "").trim();
    password = String(body.password || "");
    mode = String(body.mode || "managed");
    displayName = String(body.displayName || "").trim();
    referralCode = String(body.referral_code || body.referralCode || "").trim();
    legalAgreement =
      body.legal_agreement === "accepted" ||
      body.legal_agreement === true ||
      body.legalAgreement === "accepted" ||
      body.legalAgreement === true;
    honeypot = String(body[SIGNUP_HONEYPOT_FIELD] || "");
    turnstileToken = String(
      body.turnstileToken || body["cf-turnstile-response"] || ""
    );
  } else {
    const form = await req.formData();
    orgName = String(form.get("orgName") || "").trim();
    email = String(form.get("email") || "").trim();
    password = String(form.get("password") || "");
    mode = String(form.get("mode") || "managed");
    displayName = String(form.get("displayName") || "").trim();
    referralCode = String(
      form.get("referral_code") || form.get("referralCode") || ""
    ).trim();
    legalAgreement = form.get("legal_agreement") === "accepted";
    honeypot = String(form.get(SIGNUP_HONEYPOT_FIELD) || "");
    turnstileToken = String(form.get("cf-turnstile-response") || "");
  }

  if (!legalAgreement) {
    return NextResponse.json(
      {
        error: "legal_agreement_required",
        message: "利用規約とプライバシーポリシーへの同意が必要です",
      },
      { status: 400 }
    );
  }

  if (!email) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  function rejectToForm(code: string, status: number, message: string) {
    if (!contentType.includes("application/json")) {
      // Plain HTML form: back to /signup with a fixed error code (no echo of input).
      const back = new URL("/signup", req.url);
      back.searchParams.set("error", code);
      return NextResponse.redirect(back, 303);
    }
    return NextResponse.json({ error: code, message }, { status });
  }

  // IP_HASH_KEY required (no dev fallback): the signup fingerprint is keyed with it.
  // Refuse before the guard, attempt log, Auth user, org or any email.
  if (!isIpHashKeyConfigured()) {
    console.error("[signup] IP_HASH_KEY not configured; refusing");
    return rejectToForm("signup_unavailable", 503, "現在、新規登録を一時停止しています。時間をおいてお試しください。");
  }

  // Layer 2 (flags default OFF): attempt log / rate limit / domain checks.
  const attemptStore = anySignupLayer2Enabled() ? createSupabaseSignupAttemptStore() : null;
  const fingerprint = fingerprintSignup(req, email);

  // Bot protection runs before any Auth user / org / email side effect.
  // Not behind a flag (P0 hotfix spam-sample-20261003); Turnstile fail-closed outside DEMO.
  const guard = await evaluateSignupGuard(
    {
      orgName,
      referralCode,
      honeypot,
      turnstileToken,
      clientIp: getClientIp(req),
      demo: isDemoMode(),
    },
    {
      turnstileConfigured: () => getTurnstileConfig() !== null,
      verifyTurnstile: verifyTurnstileToken,
    }
  );
  if (!guard.ok) {
    await recordSignupAttempt(attemptStore, fingerprint, "rejected_guard", {
      reason: guard.error,
      honeypot: guard.error === "signup_rejected",
      turnstileOk: guard.error === "turnstile_failed" ? false : null,
    });
    return rejectToForm(guard.error, guard.status, guard.message);
  }
  orgName = guard.orgName;
  referralCode = guard.referralCode ?? "";

  const layer2 = await evaluateSignupLayer2(attemptStore, fingerprint);
  if (!layer2.ok) {
    await recordSignupAttempt(attemptStore, fingerprint, layer2.outcome, {
      reason: layer2.reason,
      turnstileOk: isDemoMode() ? null : true,
    });
    const code = layer2.outcome === "rejected_domain" ? layer2.reason : layer2.outcome;
    return rejectToForm(code, layer2.status, layer2.message);
  }

  if (isDemoMode()) {
    if (referralCode) {
      await setOrgReferralCodeIfEmpty(DEMO_ORG.id, referralCode);
    }
    await sendWelcomeEmail(email, orgName || "新しい組織");
    await sendTrialStartedEmail(email, TRIAL_DAYS);
    const url = new URL("/app", req.url);
    url.searchParams.set("trial", "1");
    url.searchParams.set("mode", mode);
    url.searchParams.set("demo", "1");
    return NextResponse.redirect(url, 303);
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "password_min_8", message: "パスワードは8文字以上にしてください" },
      { status: 400 }
    );
  }

  const integrationMode = mode === "byo" ? "byo" : "managed";

  async function finishOk(orgId: string) {
    await establishSession(email, password);
    await sendWelcomeEmail(email, orgName || "新しい組織");
    await sendTrialStartedEmail(email, TRIAL_DAYS);

    if (contentType.includes("application/json")) {
      return NextResponse.json({ ok: true, orgId, demo: false });
    }
    const url = new URL("/app", req.url);
    url.searchParams.set("trial", "1");
    return NextResponse.redirect(url, 303);
  }

  /** Auth-only user: sign in + create org (idempotent). */
  async function recoverOrphanedAuthUser(): Promise<NextResponse | null> {
    const { error: signErr, data } = await establishSession(email, password);
    if (signErr || !data.user) {
      return null;
    }
    try {
      const provisioned = await provisionOrgForUser({
        userId: data.user.id,
        email,
        orgName: orgName || "新しい組織",
        integrationMode,
        displayName: displayName || undefined,
        referralCode: referralCode || null,
      });
      await sendWelcomeEmail(email, orgName || "新しい組織");
      await sendTrialStartedEmail(email, TRIAL_DAYS);
      if (contentType.includes("application/json")) {
        return NextResponse.json({
          ok: true,
          orgId: provisioned.orgId,
          demo: false,
          recovered: true,
        });
      }
      const url = new URL("/app", req.url);
      url.searchParams.set("trial", "1");
      url.searchParams.set("recovered", "1");
      return NextResponse.redirect(url, 303);
    } catch (pe) {
      const pm = pe instanceof Error ? pe.message : "provision_failed";
      const onboarding = new URL("/onboarding", req.url);
      onboarding.searchParams.set(
        "reason",
        /does not exist|schema cache|could not find the table|relation/i.test(pm)
          ? "schema"
          : "provision"
      );
      onboarding.searchParams.set("detail", pm.slice(0, 160));
      if (contentType.includes("application/json")) {
        return NextResponse.json(
          { error: "org_provision_failed", message: pm, repair: "/onboarding" },
          { status: 503 }
        );
      }
      return NextResponse.redirect(onboarding, 303);
    }
  }

  try {
    const { orgId, userId } = await createOrgWithOwner({
      email,
      password,
      orgName: orgName || "新しい組織",
      integrationMode,
      displayName: displayName || undefined,
      referralCode: referralCode || null,
    });
    await recordSignupAttempt(attemptStore, fingerprint, "created", {
      turnstileOk: isDemoMode() ? null : true,
      orgId,
      userId,
    });
    return await finishOk(orgId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "signup_failed";
    await recordSignupAttempt(attemptStore, fingerprint, "error", {
      reason: message.split(":")[0].slice(0, 40),
      turnstileOk: isDemoMode() ? null : true,
    });

    // Auth created, org failed mid-signup — session + provision or soft onboarding.
    if (message.startsWith("auth_ok_org_failed:")) {
      const recovered = await recoverOrphanedAuthUser();
      if (recovered) return recovered;
      const detail = message.slice("auth_ok_org_failed:".length);
      if (contentType.includes("application/json")) {
        return NextResponse.json(
          {
            error: "auth_ok_org_failed",
            message: detail,
            hint: "Login then open /app or /api/auth/repair-org",
          },
          { status: 503 }
        );
      }
      // Establish session if possible so /onboarding repair works.
      await establishSession(email, password).catch(() => null);
      const url = new URL("/onboarding", req.url);
      url.searchParams.set(
        "reason",
        /does not exist|schema cache|could not find the table|relation/i.test(
          detail
        )
          ? "schema"
          : "provision"
      );
      url.searchParams.set("detail", detail.slice(0, 160));
      return NextResponse.redirect(url, 303);
    }

    // Email already registered (often: prior failed signup left Auth user).
    if (
      message.startsWith("email_exists:") ||
      /already|registered|exists/i.test(message)
    ) {
      const recovered = await recoverOrphanedAuthUser();
      if (recovered) return recovered;
      return NextResponse.json(
        {
          error: "email_exists",
          message:
            "このメールは既に登録されています。ログインしてください。組織が無い場合はログイン後に自動修復されます。",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
