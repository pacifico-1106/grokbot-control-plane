import { NextResponse } from "next/server";
import { createOrgWithOwner } from "@/lib/auth/session";
import { sendTrialStartedEmail, sendWelcomeEmail } from "@/lib/email";
import { isDemoMode } from "@/lib/mode";
import { TRIAL_DAYS } from "@/lib/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const runtime = "nodejs";

/**
 * Production signup: auth user + org + owner member, then session cookie.
 * DEMO: redirect to /app like /api/trial (no hard crash).
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  let orgName = "";
  let email = "";
  let password = "";
  let mode = "managed";
  let displayName = "";

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    orgName = String(body.orgName || "").trim();
    email = String(body.email || "").trim();
    password = String(body.password || "");
    mode = String(body.mode || "managed");
    displayName = String(body.displayName || "").trim();
  } else {
    const form = await req.formData();
    orgName = String(form.get("orgName") || "").trim();
    email = String(form.get("email") || "").trim();
    password = String(form.get("password") || "");
    mode = String(form.get("mode") || "managed");
    displayName = String(form.get("displayName") || "").trim();
  }

  if (!email) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }

  if (isDemoMode()) {
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

  try {
    const { orgId } = await createOrgWithOwner({
      email,
      password,
      orgName: orgName || "新しい組織",
      integrationMode: mode === "byo" ? "byo" : "managed",
      displayName: displayName || undefined,
    });

    // Establish browser session
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options as never);
            });
          },
        },
      }
    );
    await supabase.auth.signInWithPassword({ email, password });

    await sendWelcomeEmail(email, orgName || "新しい組織");
    await sendTrialStartedEmail(email, TRIAL_DAYS);

    if (contentType.includes("application/json")) {
      return NextResponse.json({ ok: true, orgId, demo: false });
    }
    const url = new URL("/app", req.url);
    url.searchParams.set("trial", "1");
    return NextResponse.redirect(url, 303);
  } catch (e) {
    const message = e instanceof Error ? e.message : "signup_failed";
    // Fallback: if user already exists, try sign-in only
    if (message.includes("already")) {
      return NextResponse.json(
        { error: "email_exists", message: "このメールは既に登録されています。ログインしてください。" },
        { status: 409 }
      );
    }
    void createSupabaseAdminClient;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
