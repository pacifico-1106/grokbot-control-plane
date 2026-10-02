import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isDemoMode()) {
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
    await supabase.auth.signOut();
  }
  // Consent screen "switch org / re-login": come back to the same consent request.
  // Only the exact /oauth/consent?rid=<token> shape is honoured (no open redirect).
  const nextRaw = await req
    .formData()
    .then((f) => f.get("next"))
    .catch(() => null);
  const login = new URL("/login", req.url);
  if (typeof nextRaw === "string" && /^\/oauth\/consent\?rid=[A-Za-z0-9_-]{1,128}$/.test(nextRaw)) {
    login.searchParams.set("next", nextRaw);
  }
  return NextResponse.redirect(login, 303);
}
