/**
 * Parse comma-separated allowed purposes from hire / post-hire policy UI.
 * Splits on ASCII comma, Japanese comma, and newlines; trims; drops empty; keeps order.
 */
export function parsePurposes(csv: string): string[] {
  return csv
    .split(/[,、\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}
