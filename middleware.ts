import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

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
 * Production → refresh session cookies; redirect unauthenticated /app to /login.
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
  const isAuthPage = path === "/login" || path === "/signup";

  if (isApp && !user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  if (isAuthPage && user) {
    return NextResponse.redirect(new URL("/app", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/login", "/signup"],
};
