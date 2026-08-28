import { notFound, redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { getSuperAdminAccess } from "@/lib/admin/access";

export const dynamic = "force-dynamic";

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getSuperAdminAccess();

  if (!access.allowed) {
    if (access.reason === "unauthenticated") redirect("/login?next=/admin&reason=session");
    notFound();
  }

  return <AdminShell email={access.actor.email}>{children}</AdminShell>;
}
