/**
 * The ONE place that decides whether a human may request / approve a hold release right now
 * (木村 10/12 07:15). Today: web session whose OWN authentication happened ≤ 5 minutes ago.
 * The zero-trust design will swap this for a passkey assertion — change this function (and
 * its proof input) only; callers just pass what the surface gave them.
 *
 * Auth time (木村 10/12 08:31): the `amr[].timestamp` of THIS session's signature-verified
 * JWT (auth.getClaims(): JWKS-verified, or checked by the Auth server for symmetric keys).
 * Not the per-user sign-in time (another device's fresh sign-in must not make an old,
 * possibly stolen, session pass), not `iat` (a token refresh does not re-authenticate), and
 * never a token decoded without verification.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS, isHoldReleaseSurface } from "@/lib/safety/hold-config";
import { isDemoMode } from "@/lib/mode";

export type ReleaseProof = {
  surface: string;
  /** auth user id of the web session (from the verified user lookup). */
  userId?: string | null;
  /** Demo mode only (no Supabase): the demo session's auth time. Ignored otherwise. */
  demoAuthTime?: string | null;
};

/** Claims of a signature-verified JWT only. */
export type VerifiedClaims = { sub?: unknown; amr?: unknown; iat?: unknown; session_id?: unknown };
export type VerifiedClaimsSource = () => Promise<VerifiedClaims | null>;

export type ReleaseAuthVerdict =
  | { ok: true }
  | { ok: false; code: "hold_release_web_only" | "fresh_login_required" | "session_unverified"; httpStatus: number; message: string };

/** auth.getClaims() verifies the signature; any error → null (never fall back to decoding). */
export async function verifiedClaimsFromClient(client: Pick<SupabaseClient, "auth"> | null): Promise<VerifiedClaims | null> {
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getClaims();
    if (error || !data?.claims) return null;
    return data.claims as VerifiedClaims;
  } catch {
    return null;
  }
}

async function cookieSessionClaims(): Promise<VerifiedClaims | null> {
  const { cookies } = await import("next/headers");
  const { createSupabaseServerClient } = await import("@/lib/supabase");
  const store = await cookies();
  return verifiedClaimsFromClient(createSupabaseServerClient({ getAll: () => store.getAll() }));
}

/** Newest authentication time (ms) among the session's amr entries; null when none is usable. */
function sessionAuthTimeMs(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let best: number | null = null;
  for (const e of amr) {
    const ts = e && typeof e === "object" ? (e as { timestamp?: unknown }).timestamp : undefined;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) best = Math.max(best ?? 0, ts * 1000);
  }
  return best;
}

export async function verifyReleaseAuthentication(
  proof: ReleaseProof,
  now: Date = new Date(),
  deps: { getVerifiedClaims?: VerifiedClaimsSource } = {},
): Promise<ReleaseAuthVerdict> {
  if (!isHoldReleaseSurface(proof.surface)) {
    return { ok: false, code: "hold_release_web_only", httpStatus: 403, message: "解除はダッシュボードからのみ行えます。" };
  }
  const unverified: ReleaseAuthVerdict = { ok: false, code: "session_unverified", httpStatus: 401, message: "ログインを確認できません。ログインし直してください。" };
  let claims: VerifiedClaims | null;
  if (deps.getVerifiedClaims) {
    claims = await deps.getVerifiedClaims().catch(() => null);
  } else if (isDemoMode()) {
    const t = proof.demoAuthTime ? Date.parse(proof.demoAuthTime) : now.getTime();
    claims = { sub: proof.userId ?? null, amr: Number.isFinite(t) ? [{ method: "demo", timestamp: Math.floor(t / 1000) }] : [] };
  } else {
    claims = await cookieSessionClaims().catch(() => null);
  }
  if (!claims) return unverified;
  if (!isDemoMode() || deps.getVerifiedClaims) {
    if (!proof.userId || typeof claims.sub !== "string" || claims.sub !== proof.userId) return unverified;
  }
  const t = sessionAuthTimeMs(claims.amr);
  const age = t === null ? NaN : now.getTime() - t;
  if (t === null || age < -60_000 || age > HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS) {
    return { ok: false, code: "fresh_login_required", httpStatus: 401, message: "解除にはログインし直してください（5分以内のログインが必要です）。" };
  }
  return { ok: true };
}
