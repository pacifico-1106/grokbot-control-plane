import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  let email = "";
  let password = "";
  let next = "/app";

  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    email = String(body.email || "").trim();
    password = String(body.password || "");
    next = String(body.next || "/app");
  } else {
    const form = await req.formData();
    email = String(form.get("email") || "").trim();
    password = String(form.get("password") || "");
    next = String(form.get("next") || "/app");
  }

  if (isDemoMode()) {
    const url = new URL(next.startsWith("/") ? next : "/app", req.url);
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

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return NextResponse.json(
      { error: "login_failed", message: "ログインに失敗しました" },
      { status: 401 }
    );
  }

  if (contentType.includes("application/json")) {
    return NextResponse.json({ ok: true, demo: false });
  }
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/app", req.url), 303);
}
