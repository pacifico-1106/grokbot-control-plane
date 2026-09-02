import { redirect } from "next/navigation";
import { AppSessionProvider } from "@/components/AppSessionProvider";
import { ensureAuthenticatedOrg } from "@/lib/auth/session";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { listApprovals } from "@/lib/data";

/**
 * Soft gate for every /app/* page.
 * Login can succeed while org_members/orgs are missing (failed signup after Auth
 * user create). Auto-provision like signup; if schema is still missing, send to
 * /onboarding instead of an opaque SSR Application error.
 *
 * Also one-time-repairs seed owner@example.com on org_members when the Auth
 * session email differs, then exposes email/displayName to AppShell.
 */
export default async function AppSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const result = await ensureAuthenticatedOrg();

  if (result.status === "unauthenticated") {
    redirect("/login?next=/app&reason=session");
  }

  if (result.status === "needs_schema") {
    redirect("/onboarding?reason=schema");
  }

  if (result.status === "provision_failed") {
    redirect(
      `/onboarding?reason=provision&detail=${encodeURIComponent(result.error.slice(0, 120))}`
    );
  }

  const session = result.session;
  // Prefer Auth user email for chrome; display_name from org_members.
  const email = session.email ?? session.member?.email ?? null;
  const displayName = session.member?.displayName ?? null;
  const superAdminAccess = await getSuperAdminAccess();
  const approvals = await listApprovals(session.orgId);
  const pendingApprovalCount = approvals.filter((row) => row.status === "pending").length;

  return (
    <AppSessionProvider
      value={{
        email,
        displayName,
        demo: session.demo,
        superAdmin: superAdminAccess.allowed,
        pendingApprovalCount,
      }}
    >
      {children}
    </AppSessionProvider>
  );
}
