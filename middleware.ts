import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { matchesSuperAdminAllowlist } from "@/lib/admin/allowlist";

function looksLikePlaceholder(value: string | undefined | null): boolean {
  if (value == null) return true;
  const v = value.trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  return (
    lower.startsWith("replace_me") ||
    lower.includes("your_project") ||
    lower.includes("placeholder")
  );
}

function isDemoFromEnv(): boolean {
  return (
    looksLikePlaceholder(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
    looksLikePlaceholder(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
    looksLikePlaceholder(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

/**
 * Soft auth gate: DEMO → pass-through (no crash).
 * Production → refresh session cookies; redirect unauthenticated /app|/admin|/onboarding to /login.
 * Authenticated /login|/signup → /app (layout auto-provisions missing org).
 */
export async function middleware(request: NextRequest) {
  if (isDemoFromEnv()) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isApp = path.startsWith("/app");
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  const isOnboarding = path === "/onboarding";
  const isAuthPage = path === "/login" || path === "/signup";

  if ((isApp || isAdmin || isOnboarding) && !user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", path);
    login.searchParams.set("reason", "session");
    return NextResponse.redirect(login);
  }

  if (isAuthPage && user) {
    const superAdmin = matchesSuperAdminAllowlist({
      userId: user.id,
      email: user.email || "",
      userIds: process.env.SUPER_ADMIN_USER_IDS,
      emails: process.env.SUPER_ADMIN_EMAILS,
    });
    return NextResponse.redirect(new URL(superAdmin ? "/admin" : "/app", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/admin/:path*", "/login", "/signup", "/onboarding"],
};
