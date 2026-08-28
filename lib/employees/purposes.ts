/**
 * Parse allowed purposes from hire / post-hire policy UI.
 * Splits on ASCII comma, Japanese comma, slash, newlines, and whitespace;
 * trims; drops empty; drops tokens containing ":" (scopes pasted by mistake);
 * keeps order; dedupes.
 */
export function parsePurposes(csv: string): string[] {
  return sanitizePurposes(csv.split(/[,、/\s]+/));
}

const PURPOSE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;

/**
 * Gateway allowedPurposes must stay purpose keys, never scopes or job-text blobs.
 */
export function sanitizePurposes(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const token = raw.trim();
    if (!token) continue;
    if (token.includes(":")) continue;
    if (!PURPOSE_KEY.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function addPurposes(current: string[], extra: string[]): string[] {
  return sanitizePurposes([...current, ...extra]);
}
