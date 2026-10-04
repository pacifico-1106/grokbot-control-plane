import { appendAuditEvent } from "../data/audit";
import { isMemberInviteActivationEnabled } from "../feature-flags";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { normalizeIdentityEmail } from "../team/member-change-guard";

export type InviteEmailOutcome = "sent" | "existing_account" | "failed" | "disabled";

/**
 * One click for the invitee (八坂: no manual setup step): after a NEW invite row
 * passed the member-change guard, send the Supabase Auth invite. Its link goes
 * through /auth/confirm (server-side verifyOtp) → set password → /app, where
 * the gate binds the invite (claim_member_invites).
 *
 * - Flag OFF / demo → "disabled", nothing sent or audited.
 * - Address already has an Auth account → "existing_account" (no email; if
 *   that account was created by an invite and has no active membership, its
 *   next /app visit binds the invite).
 * - Audit `member.invite_email` with the outcome only (no token / link).
 * Never throws: the invite row is already saved.
 */
export async function sendMemberInviteEmail(input: {
  orgId: string;
  memberId: string;
  email: string;
  actorEmail?: string | null;
}): Promise<InviteEmailOutcome> {
  if (!isMemberInviteActivationEnabled() || isDemoMode()) return "disabled";
  const email = normalizeIdentityEmail(input.email);
  let outcome: InviteEmailOutcome = "failed";
  let errorStatus: number | null = null;
  const admin = createSupabaseAdminClient();
  if (admin && email) {
    try {
      const { error } = await admin.auth.admin.inviteUserByEmail(email);
      if (!error) outcome = "sent";
      else {
        errorStatus = typeof error.status === "number" ? error.status : null;
        outcome = /already|registered|exists/i.test(error.message || "") ? "existing_account" : "failed";
        if (outcome === "failed") console.warn("[team] invite email failed:", errorStatus ?? "", error.message);
      }
    } catch (e) {
      console.warn("[team] invite email failed:", e instanceof Error ? e.message : "unknown");
    }
  }
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: null,
    action: "member.invite_email",
    purpose: null,
    summary:
      outcome === "sent"
        ? `招待メールを送信: ${email}`
        : outcome === "existing_account"
          ? `招待メール未送信（既存アカウント）: ${email}`
          : `招待メール送信に失敗: ${email}`,
    actorEmail: input.actorEmail ?? undefined,
    metadata: { memberId: input.memberId, outcome, ...(errorStatus ? { errorStatus } : {}) },
  }).catch(() => null);
  return outcome;
}
