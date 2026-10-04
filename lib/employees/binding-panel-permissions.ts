import { isOrgAdminSession } from "@/lib/auth/require-org";
import type { SessionContext } from "@/lib/auth/session";
import { canIssueEmployeeCredentials, hasCapability } from "@/lib/team/rbac";

export type BindingPanelPermissions = {
  /** POST link / health → requireOrgAdminSession */
  canManageBinding: boolean;
  /** POST rotate → requireCredentialAdmin (owner/admin AND hire_issue_credentials) */
  canRotateCredential: boolean;
  /** PATCH binding (wake webhook) → requireCapability("hire_issue_credentials") */
  canEditWakeWebhook: boolean;
};

/**
 * Server-side decision for the BindingPanel controls, mirroring the API gates
 * so a session never sees a button its request would be refused for. The API
 * gates stay authoritative. Demo sessions follow the existing page convention
 * (session.demo → allowed; the demo API resolves the in-memory owner).
 */
export function bindingPanelPermissions(session: SessionContext): BindingPanelPermissions {
  if (session.demo) {
    return { canManageBinding: isOrgAdminSession(session), canRotateCredential: true, canEditWakeWebhook: true };
  }
  const member = session.userId && session.orgId ? session.member : null;
  return {
    canManageBinding: isOrgAdminSession(session),
    canRotateCredential: canIssueEmployeeCredentials(member),
    canEditWakeWebhook: hasCapability(member, "hire_issue_credentials"),
  };
}
