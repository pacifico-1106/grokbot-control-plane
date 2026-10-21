/**
 * Employee MCP visibility for an approval ticket.
 * A gb_emp_ caller may read status only when both org and requesting
 * employee match. Empty ids fail closed so admin-class tickets
 * (employeeId "") cannot be inferred through the employee tool.
 */
export function employeeOwnsApproval(
  approval: { orgId?: string | null; employeeId?: string | null },
  caller: { orgId?: string | null; employeeId?: string | null }
): boolean {
  const orgId = (approval.orgId || "").trim();
  const employeeId = (approval.employeeId || "").trim();
  const callerOrg = (caller.orgId || "").trim();
  const callerEmp = (caller.employeeId || "").trim();
  if (!orgId || !employeeId || !callerOrg || !callerEmp) return false;
  return orgId === callerOrg && employeeId === callerEmp;
}

/** Token-only HTTP poll fields when APPROVAL_STATUS_PUBLIC_MINIMAL is ON. */
export const PUBLIC_MINIMAL_STATUS_KEYS = [
  "ok",
  "demo",
  "mode",
  "approvalId",
  "status",
  "pollHint",
] as const;

export function publicMinimalStatusPayload(
  full: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_MINIMAL_STATUS_KEYS) {
    if (key in full) out[key] = full[key];
  }
  return out;
}
