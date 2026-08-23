import { AppShell } from "@/components/AppShell";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";

export default function NewEmployeePage() {
  return (
    <AppShell
      title="AI社員を雇う"
      subtitle="職務説明 → 権限の案を確認 → 予算・承認 → 社員証発行"
    >
      <HireEmployeeClient />
    </AppShell>
  );
}
