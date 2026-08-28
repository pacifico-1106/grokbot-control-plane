import { afterEach, describe, expect, test } from "bun:test";
import { getBinding } from "../bindings";
import { DEMO_ORG, getRuntimeEmployees } from "../demo-data";
import { getEmployee, terminateEmployee } from "./employees";

describe("terminateEmployee demo", () => {
  const sales = getRuntimeEmployees().find((item) => item.id === "emp_sales");
  const originalStatus = sales?.status ?? "active";
  const originalBinding = getBinding("emp_sales");
  const originalBindingSnapshot = originalBinding
    ? {
        status: originalBinding.status,
        lastError: originalBinding.lastError,
        grokBotAgentId: originalBinding.grokBotAgentId,
      }
    : null;

  afterEach(() => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_sales");
    if (emp) Object.assign(emp, { status: originalStatus });
    const binding = getBinding("emp_sales");
    if (binding && originalBindingSnapshot) {
      binding.status = originalBindingSnapshot.status;
      binding.lastError = originalBindingSnapshot.lastError;
      binding.grokBotAgentId = originalBindingSnapshot.grokBotAgentId;
    }
  });

  test("other-org terminate is null and does not mutate emp_sales", async () => {
    const before = await getEmployee("emp_sales", DEMO_ORG.id);
    expect(before?.id).toBe("emp_sales");
    expect(await terminateEmployee({ orgId: "org_other", employeeId: "emp_sales" })).toBeNull();
    const after = await getEmployee("emp_sales", DEMO_ORG.id);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe(before?.status);
  });

  test("terminate emp_sales suspends, keeps id, revokes binding, is idempotent", async () => {
    const before = await getEmployee("emp_sales", DEMO_ORG.id);
    expect(before?.id).toBe("emp_sales");
    expect(before?.orgId).toBe(DEMO_ORG.id);

    const terminated = await terminateEmployee({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
    });
    expect(terminated).not.toBeNull();
    expect(terminated?.status).toBe("suspended");
    expect(terminated?.id).toBe("emp_sales");
    expect(terminated?.orgId).toBe(DEMO_ORG.id);

    const sameOrg = await getEmployee("emp_sales", DEMO_ORG.id);
    expect(sameOrg).not.toBeNull();
    expect(sameOrg?.id).toBe(before?.id);
    expect(sameOrg?.status).toBe("suspended");

    const binding = getBinding("emp_sales");
    expect(binding?.status).toBe("revoked");

    const again = await terminateEmployee({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
    });
    expect(again?.status).toBe("suspended");
    expect(again?.id).toBe("emp_sales");
    expect(getBinding("emp_sales")?.status).toBe("revoked");
  });
});
