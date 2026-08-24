import { NextResponse } from "next/server";
import {
  getSessionContext,
  provisionOrgForUser,
} from "@/lib/auth/session";
import { isDemoMode } from "@/lib/mode";

export const runtime = "nodejs";

/**
 * Explicit repair for Auth-only users (signup created Auth, org insert failed).
 * POST/GET → provision org if missing → redirect /app.
 * Bookmark: GET /api/auth/repair-org
 */
async function repair(req: Request) {
  if (isDemoMode()) {
    return NextResponse.redirect(new URL("/app?demo=1", req.url), 303);
  }

  const session = await getSessionContext();
  if (!session.userId) {
    return NextResponse.redirect(new URL("/login?next=/onboarding", req.url), 303);
  }

  if (session.orgId) {
    return NextResponse.redirect(new URL("/app", req.url), 303);
  }

  try {
    await provisionOrgForUser({
      userId: session.userId,
      email: session.email || "owner@unknown.local",
      orgName: "新しい組織",
      displayName: session.email?.split("@")[0],
    });
    return NextResponse.redirect(new URL("/app", req.url), 303);
  } catch (e) {
    const message = e instanceof Error ? e.message : "provision_failed";
    const url = new URL("/onboarding", req.url);
    url.searchParams.set(
      "reason",
      /does not exist|schema cache|could not find the table|relation/i.test(message)
        ? "schema"
        : "provision"
    );
    url.searchParams.set("detail", message.slice(0, 160));
    return NextResponse.redirect(url, 303);
  }
}

export async function POST(req: Request) {
  return repair(req);
}

export async function GET(req: Request) {
  return repair(req);
}
