/**
 * Parse allowed purposes from hire / post-hire policy UI.
 * Splits on ASCII comma, Japanese comma, slash, newlines, and whitespace;
 * trims; drops empty; drops tokens containing ":" (scopes pasted by mistake);
 * keeps order; dedupes.
 */
export function parsePurposes(csv: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of csv.split(/[,、/\s]+/)) {
    const token = part.trim();
    if (!token) continue;
    if (token.includes(":")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
