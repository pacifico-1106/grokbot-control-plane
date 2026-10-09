/**
 * What admin MCP intake stores for a policy.patch ticket since #275: the
 * parsed args plus the server-built card record (base + SoD verdict), with
 * the card text as the approval summary. Tests that build tickets by hand use
 * this so fulfil's card / stale / SoD gates see what a real ticket carries.
 * Args the intake would refuse are returned as-is (no card): such a ticket is
 * only useful for classification-only tests and is refused at fulfil.
 * Reads the CURRENT employee (call it at filing time, before any change).
 */
export async function policyPatchTicket(
  orgId: string,
  args: Record<string, unknown>
): Promise<{ adminMutation: Record<string, unknown>; summary: string }> {
  const { parsePolicyPatchArgs, buildPolicyPatchCard, POLICY_PATCH_CARD_KEY } = await import("@/lib/admin-mcp/policy-patch-guard");
  const { getEmployee } = await import("@/lib/data/employees");
  const { getOrgSodWarnPolicy } = await import("@/lib/data/org-context");
  const parsed = parsePolicyPatchArgs(args);
  if (!parsed.ok) return { adminMutation: args, summary: "policy.patch" };
  const employee = await getEmployee(parsed.value.employeeId, orgId);
  if (!employee) throw new Error("policyPatchTicket: employee_not_found");
  const card = buildPolicyPatchCard(employee, parsed.value, await getOrgSodWarnPolicy(orgId));
  if (!card.fitsAllSurfaces) throw new Error("policyPatchTicket: card does not fit every surface");
  return { adminMutation: { ...parsed.value, [POLICY_PATCH_CARD_KEY]: card.snapshot }, summary: card.summaryJa };
}
