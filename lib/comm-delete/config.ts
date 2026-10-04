/**
 * comm.delete configuration (fail-first stub; implemented in the next commit).
 */
export const COMM_DELETE_TOOL_ID = "comm.delete" as const;

export function isCommDeleteEnabled(): boolean {
  return false;
}

export function commDeleteMaxAgeHours(): number {
  return 0;
}
