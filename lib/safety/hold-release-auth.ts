/**
 * The ONE place that decides whether a human may request / approve a hold release right now
 * (木村 10/12 07:15). Today: web session with a fresh login (≤ 5 minutes). The zero-trust
 * design will swap this for a passkey assertion — change this function (and its proof
 * input) only; callers just pass what the surface gave them.
 */
import { HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS, isHoldReleaseSurface } from "@/lib/safety/hold-config";

export type ReleaseProof = {
  surface: string;
  /** web: Supabase auth.users.last_sign_in_at of the session. */
  lastSignInAt?: string | null;
};

export type ReleaseAuthVerdict =
  | { ok: true }
  | { ok: false; code: "hold_release_web_only" | "fresh_login_required"; httpStatus: number; message: string };

export function verifyReleaseAuthentication(proof: ReleaseProof, now: Date = new Date()): ReleaseAuthVerdict {
  if (!isHoldReleaseSurface(proof.surface)) {
    return { ok: false, code: "hold_release_web_only", httpStatus: 403, message: "解除はダッシュボードからのみ行えます。" };
  }
  const t = proof.lastSignInAt ? Date.parse(proof.lastSignInAt) : NaN;
  const age = now.getTime() - t;
  if (!Number.isFinite(t) || age < -60_000 || age > HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS) {
    return { ok: false, code: "fresh_login_required", httpStatus: 401, message: "解除にはログインし直してください（5分以内のログインが必要です）。" };
  }
  return { ok: true };
}
