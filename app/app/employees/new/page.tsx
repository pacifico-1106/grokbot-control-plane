import { AppShell } from "@/components/AppShell";
import { HireEmployeeClient } from "@/components/employees/HireEmployeeClient";

export default function NewEmployeePage() {
  return (
    <AppShell
      title="AI社員を雇う"
      subtitle="職務を日本語で説明 → 権限 Draft → 社員証発行"
    >
      <HireEmployeeClient />
    </AppShell>
  );
}
