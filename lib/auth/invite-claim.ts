import { isMemberInviteActivationEnabled } from "../feature-flags";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";

/**
 * Invite activation (木村 2026-10-04 #1, flag MEMBER_INVITE_ACTIVATION_ENABLED).
 *
 * Binds the caller's pending invite via the DB RPC claim_member_invites
 * (migration 20261004900000). Only the server-verified Auth user id is sent:
 * the DB reads that user's email / invited_at / email_confirmed_at from
 * auth.users itself and matches the invite email after NFKC + trim + lower, so
 * nothing the browser sends (body, header, query, cookie claims) can pick or
 * widen the invite. Role and capabilities stay exactly as invited; the audit
 * row is written in the same transaction.
 *
 * Fail closed: any error → `error` (caller keeps "no membership").
 */
export type InviteClaimResult =
  | { status: "disabled" }
  | { status: "claimed"; memberId: string; orgId: string }
  | { status: "none"; reason: string }
  | { status: "error"; error: string };

export async function claimPendingInvite(userId: string | null | undefined): Promise<InviteClaimResult> {
  if (!isMemberInviteActivationEnabled() || isDemoMode()) return { status: "disabled" };
  if (!userId) return { status: "none", reason: "not_eligible" };
  const admin = createSupabaseAdminClient();
  if (!admin) return { status: "error", error: "supabase_not_configured" };
  try {
    const { data, error } = await admin.rpc("claim_member_invites", { p_user_id: userId });
    if (error) {
      console.warn("[auth] claim_member_invites failed:", error.code || "", error.message);
      return { status: "error", error: error.message || "claim_failed" };
    }
    const r = (data ?? {}) as { status?: unknown; reason?: unknown; member_id?: unknown; org_id?: unknown };
    if (r.status === "claimed" && typeof r.member_id === "string" && typeof r.org_id === "string") {
      return { status: "claimed", memberId: r.member_id, orgId: r.org_id };
    }
    if (r.status === "none" && typeof r.reason === "string") {
      return { status: "none", reason: r.reason };
    }
    return { status: "error", error: "claim_result_malformed" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "claim_failed" };
  }
}
