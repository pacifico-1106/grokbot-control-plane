/**
 * Resolve the LP guest journey from the signed HttpOnly guest cookie.
 *
 * Every guest-facing LP endpoint that reads or changes journey-scoped data
 * must bind the request to the caller's own journey through this helper,
 * never through an id supplied in the request body or query string.
 */
import { cookies } from "next/headers";
import {
  getJourneyByTokenHash,
  hashToken,
  parseGuestCookie,
  verifySignature,
  type Journey,
} from "@/lib/lp/journeys";

export const GUEST_COOKIE_NAME = "lp_guest";
export const CSRF_COOKIE_NAME = "lp_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export type GuestSessionResult =
  | { ok: true; journey: Journey }
  | { ok: false; status: 401 | 403; error: "auth_required" | "invalid_session" | "csrf_invalid" | "session_expired" };

export async function resolveGuestJourney(
  req: Request,
  options: { requireCsrf: boolean }
): Promise<GuestSessionResult> {
  const cookieStore = await cookies();
  const guestCookie = cookieStore.get(GUEST_COOKIE_NAME)?.value;
  if (!guestCookie) return { ok: false, status: 401, error: "auth_required" };

  const parsed = parseGuestCookie(guestCookie);
  if (!parsed || !verifySignature(parsed.token, parsed.signature)) {
    return { ok: false, status: 401, error: "invalid_session" };
  }

  if (options.requireCsrf) {
    const csrfHeader = req.headers.get(CSRF_HEADER_NAME);
    const csrfCookie = cookieStore.get(CSRF_COOKIE_NAME)?.value;
    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return { ok: false, status: 403, error: "csrf_invalid" };
    }
  }

  const journey = await getJourneyByTokenHash(hashToken(parsed.token));
  if (!journey) return { ok: false, status: 401, error: "session_expired" };
  return { ok: true, journey };
}
