/**
 * Post-hire employee identity (display name / role label).
 * employee.id is immutable; these fields are the editable badge name.
 */
export const EMPLOYEE_IDENTITY_MAX_LEN = 80;

/**
 * Trim and cap a display-name or role-label field.
 * Empty after trim is invalid — callers return 400 { error: "invalid_identity" }.
 */
export function normalizeEmployeeIdentityField(value: unknown): string {
  return String(value ?? "").trim().slice(0, EMPLOYEE_IDENTITY_MAX_LEN);
}
