import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { appendAuditEvent } from "@/lib/data/audit";
import { consumeSlackOAuthStateNonce } from "@/lib/data/slack-oauth-state-uses";
import {
  SHARED_APPROVAL_INSTALL_COOKIE,
  SHARED_APPROVAL_STATE_PURPOSE,
  completeSharedApprovalInstall,
  isSharedApprovalAppEnabled,
  sharedApprovalResultHtml,
  verifySharedApprovalInstallState,
} from "@/lib/slack/shared-approval-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: OAuth callback of the shared approval app.
 * org = verified signed state AND the same org's owner/admin session; the state
 * is single use. Never logs / returns the token.
 */
export async function GET(req: Request) {
  if (!isSharedApprovalAppEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const oauthError = url.searchParams.get("error")?.trim() || "";
  const jar = await cookies();
  const nonce = jar.get(SHARED_APPROVAL_INSTALL_COOKIE)?.value || "";
  jar.delete(SHARED_APPROVAL_INSTALL_COOKIE);

  const parsed = verifySharedApprovalInstallState(state, nonce);
  if (!parsed) return sharedApprovalResultHtml({ ok: false, code: "state_invalid" }, 400);

  const gate = await requireOrgAdminSession();
  if (!gate.ok || gate.orgId !== parsed.orgId) {
    return sharedApprovalResultHtml({ ok: false, code: "session_mismatch" }, 403);
  }
  const fresh = await consumeSlackOAuthStateNonce({
    purpose: SHARED_APPROVAL_STATE_PURPOSE,
    nonce: parsed.nonce,
    orgId: parsed.orgId,
    expiresAtMs: parsed.exp,
  });
  if (!fresh) return sharedApprovalResultHtml({ ok: false, code: "state_reused" }, 400);

  if (oauthError || !code) {
    await appendAuditEvent({
      orgId: parsed.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: gate.email,
      action: "admin.notificationChannel",
      purpose: "admin.notificationChannel",
      summary: "共通承認アプリのインストールがキャンセルされました",
      metadata: { auditClass: "admin", event: "shared_approval_app.install_rejected", code: "denied" },
    }).catch(() => undefined);
    return sharedApprovalResultHtml({ ok: false, code: "denied" }, 200);
  }
  const result = await completeSharedApprovalInstall({ orgId: parsed.orgId, code, actorEmail: gate.email });
  if (!result.ok) {
    console.warn(`slack_shared_approval_install: rejected org=${parsed.orgId} code=${result.code}`);
    return sharedApprovalResultHtml({ ok: false, code: result.code }, result.code === "team_bound_to_other_org" ? 409 : 400);
  }
  console.info(`slack_shared_approval_install: ok org=${parsed.orgId} team=${result.teamId}`);
  return sharedApprovalResultHtml({ ok: true, code: "installed", teamName: result.teamName });
}
