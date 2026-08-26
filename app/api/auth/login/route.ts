import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";

export const runtime = "nodejs";

function safeDestination(value: string, requestUrl: string): string {
  try {
    const base = new URL(requestUrl);
    const candidate = new URL(value, base);
    if (candidate.origin !== base.origin) return "/app";
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return "/app";
  }
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  let email = "";
  let password = "";
  let next = "/app";

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    email = String(body.email || "").trim();
    password = String(body.password || "");
    next = safeDestination(String(body.next || "/app"), req.url);
  } else {
    const form = await req.formData();
    email = String(form.get("email") || "").trim();
    password = String(form.get("password") || "");
    next = safeDestination(String(form.get("next") || "/app"), req.url);
  }

  if (isDemoMode()) {
    const url = new URL(next, req.url);
    url.searchParams.set("demo", "1");
    return NextResponse.redirect(url, 303);
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: "credentials_required", message: "メールとパスワードが必要です" },
      { status: 400 }
    );
  }

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

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return NextResponse.json(
      { error: "login_failed", message: "ログインに失敗しました" },
      { status: 401 }
    );
  }

  if (contentType.includes("application/json")) {
    return NextResponse.json({ ok: true, demo: false });
  }
  const superAdmin = data.user && matchesSuperAdminAllowlist({
    userId: data.user.id,
    email: data.user.email || email,
    userIds: process.env.SUPER_ADMIN_USER_IDS,
    emails: process.env.SUPER_ADMIN_EMAILS,
  });
  const destination = next === "/app" && superAdmin ? "/admin" : next;
  return NextResponse.redirect(new URL(destination, req.url), 303);
}
