import { AppShell } from "@/components/AppShell";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";
import { getCurrentOrgId } from "@/lib/auth/session";
import { getOrgSodWarnPolicy, listMembers, listNotificationChannels, listOrgProjects } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NewEmployeePage() {
  const orgId = await getCurrentOrgId();
  const members = await listMembers(orgId);
  const projects = await listOrgProjects(orgId);
  const sodWarnPolicy = await getOrgSodWarnPolicy(orgId);
  const notificationChannels = await listNotificationChannels(orgId);
  return (
    <AppShell
      title="AI社員を雇う"
      subtitle="職務説明 → 権限の案を確認 → 予算・承認 → 社員証発行"
    >
      <HireEmployeeClient members={members} projects={projects} sodWarnPolicy={sodWarnPolicy} notificationChannels={notificationChannels} />
    </AppShell>
  );
}
