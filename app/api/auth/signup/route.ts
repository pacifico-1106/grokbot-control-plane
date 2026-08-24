import { NextResponse } from "next/server";
import {
  createOrgWithOwner,
  provisionOrgForUser,
} from "@/lib/auth/session";
import { setOrgReferralCodeIfEmpty } from "@/lib/data/org-context";
import { DEMO_ORG } from "@/lib/demo-data";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { isDemoMode } from "@/lib/mode";
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
 * DEMO: redirect to /app like /api/trial (no hard crash).
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

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    orgName = String(body.orgName || "").trim();
    email = String(body.email || "").trim();
    password = String(body.password || "");
    mode = String(body.mode || "managed");
    displayName = String(body.displayName || "").trim();
    referralCode = String(body.referral_code || body.referralCode || "").trim();
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
  }

  if (!email) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
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
    const { orgId } = await createOrgWithOwner({
      email,
      password,
      orgName: orgName || "新しい組織",
      integrationMode,
      displayName: displayName || undefined,
      referralCode: referralCode || null,
    });
    return await finishOk(orgId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "signup_failed";

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
