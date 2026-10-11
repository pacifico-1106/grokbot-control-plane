/**
 * Shared fixtures for the identity-link (Slack / Google OAuth) authz tests.
 * Two orgs, one employee each, and members with / without hire_issue_credentials.
 */
import type { SessionContext } from "@/lib/auth/session";
import type { HumanCapability, OrgMember } from "@/lib/types";

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "99999999-9999-4999-8999-999999999999";
export const EMP_A = "emp_identity_a";
export const EMP_B = "emp_identity_b";

export const ALL_CAPS: HumanCapability[] = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
];

export function member(
  id: string,
  orgId: string,
  role: OrgMember["role"],
  capabilities: HumanCapability[]
): OrgMember {
  return {
    id,
    orgId,
    email: `${id}@example.com`,
    displayName: id,
    role,
    jobRole: role === "owner" ? "owner" : "custom",
    capabilities,
    status: "active",
  } as OrgMember;
}

export const OWNER_A = member("22222222-2222-4222-8222-222222222222", ORG_A, "owner", ALL_CAPS);
/** Plain member: can see employees, cannot manage their identity connections. */
export const PLAIN_A = member("33333333-3333-4333-8333-333333333333", ORG_A, "member", [
  "view_dashboard",
  "view_employees",
  "approve_actions",
  "manage_team",
]);
/** Member role that holds hire_issue_credentials through a job-role pack (e.g. 総務). */
export const HIRER_A = member("44444444-4444-4444-8444-444444444444", ORG_A, "member", [
  "view_dashboard",
  "view_employees",
  "hire_issue_credentials",
]);
export const HIRER_A2 = member("55555555-5555-4555-8555-555555555555", ORG_A, "member", [
  "view_dashboard",
  "hire_issue_credentials",
]);
export const OWNER_B = member("66666666-6666-4666-8666-666666666666", ORG_B, "owner", ALL_CAPS);

export function sessionAs(m: OrgMember): SessionContext {
  return { demo: false, userId: `user-${m.id}`, email: m.email, orgId: m.orgId, member: m };
}

export const UNAUTHENTICATED: SessionContext = { demo: false, userId: null, email: null, orgId: null, member: null };

export function makeCookieJar() {
  const jar = new Map<string, string>();
  return {
    jar,
    fake: {
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    },
  };
}
