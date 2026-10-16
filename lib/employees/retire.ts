/** Stub — fail-first. Real implementation lands after the tests fail. */
export const EMPLOYEE_RETIRE_TOOL = "employees.retire" as const;
export const EMPLOYEE_RETIRE_ALLOWED_ARGS = ["employeeId", "jobId", "approvalId"] as const;

export async function retireEmployee(_input: {
  orgId: string;
  employeeId: string;
  actorEmail: string;
  reason?: string;
}): Promise<null> {
  return null;
}

export async function handleEmployeeRetireTool(): Promise<{
  kind: "result";
  isError: true;
  data: { ok: false; code: string };
}> {
  return { kind: "result", isError: true, data: { ok: false, code: "not_implemented" } };
}

export async function fulfillEmployeeRetire(): Promise<{ ok: false; code: string; messageJa: string }> {
  return { ok: false, code: "not_implemented", messageJa: "not_implemented" };
}
