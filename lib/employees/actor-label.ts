/**
 * Resolve a non-blank actor for approvals / audit UI.
 * Never includes poll URLs, status tokens, or other secrets.
 */
export type ActorLabel = {
  /** Never blank: displayName, else employeeId, else 不明. */
  name: string;
  /** Non-secret employee identifier (empty when unknown). */
  employeeId: string;
};

export function actorLabel(
  employee: { displayName?: string | null } | undefined | null,
  employeeId: string | null | undefined
): ActorLabel {
  const id = String(employeeId ?? "").trim();
  const name = String(employee?.displayName ?? "").trim();
  return {
    name: name || id || "不明",
    employeeId: id,
  };
}
