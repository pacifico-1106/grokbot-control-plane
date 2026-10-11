/**
 * One-line card value (no imports, so light modules such as the browser DTO
 * builder lib/approvals/public.ts can use it without pulling the summary
 * builder's gateway dependencies).
 */
export function oneLineCardValue(value: string): string {
  // C0 + DEL + C1 (incl. NEL U+0085) + LS / PS
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
}
