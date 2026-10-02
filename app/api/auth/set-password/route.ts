import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/mode";
import { createRouteSupabase } from "@/lib/auth/route-supabase";
import {
  clientIp,
  isSameOriginRequest,
  rateKey,
  takeRateLimit,
  validateNewPassword,
} from "@/lib/auth/auth-flow";

export const runtime = "nodejs";

function back(req: Request, code: string, flow: string | null) {
  const url = new URL("/auth/set-password", req.url);
  url.searchParams.set("error", code);
  if (flow === "invite" || flow === "recovery") url.searchParams.set("flow", flow);
  return NextResponse.redirect(url, 303);
}

/**
 * Set / reset password for the *current* session (established by
 * /auth/confirm verifyOtp, or a normal login). Same-origin only (CSRF),
 * per-IP + per-user rate limited. Revokes the user's other sessions after a
 * successful change so a leaked/old session can't keep using the account.
 */
export async function POST(req: Request) {
  if (!isSameOriginRequest(req.headers, req.url)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const flowRaw = String(form?.get("flow") || "");
  const flow = flowRaw === "invite" || flowRaw === "recovery" ? flowRaw : null;

  if (!takeRateLimit(`setpw:ip:${rateKey(clientIp(req.headers))}`, 10, 10 * 60_000)) {
    return back(req, "rate_limited", flow);
  }
  if (isDemoMode()) {
    return NextResponse.redirect(new URL("/app?demo=1", req.url), 303);
  }

  const supabase = await createRouteSupabase();
  if (!supabase) return back(req, "failed", flow);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?reason=session", req.url), 303);
  }
  if (!takeRateLimit(`setpw:user:${rateKey(user.id)}`, 5, 10 * 60_000)) {
    return back(req, "rate_limited", flow);
  }

  const password = String(form?.get("password") || "");
  const confirm = String(form?.get("password_confirm") || "");
  const problem = validateNewPassword(password, confirm, user.email);
  if (problem) return back(req, problem, flow);

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return back(req, "failed", flow);

  // Best effort: kill other refresh tokens (old devices / leaked sessions).
  await supabase.auth.signOut({ scope: "others" }).catch(() => null);

  return NextResponse.redirect(new URL("/app", req.url), 303);
}
