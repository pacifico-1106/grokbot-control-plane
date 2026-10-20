/**
 * Publish-time wording warnings. Not a security control — operators can
 * confirm and publish. Blocks nothing.
 */
export type CopyLintWarning = { code: "phrase" | "url"; messageJa: string; detail: string };

const PHRASES = [
  "承認不要",
  "承認を省略",
  "ignore previous",
  "system prompt",
  "token",
  "gb_emp_",
  "送信してください",
];

const ALLOWED_HOSTS = new Set([
  "staffpass.sealith.com",
  "staffpass.jp",
  "www.staffpass.jp",
  "tokyo307inc.com",
  "www.tokyo307inc.com",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export function lintNoticeCopy(input: {
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  changeNote?: string;
}): { blocking: false; warnings: CopyLintWarning[] } {
  const text = [input.title, input.changeSummary, input.aiUsageChange, input.changeNote ?? ""].join("\n");
  const warnings: CopyLintWarning[] = [];
  const lower = text.toLowerCase();
  for (const phrase of PHRASES) {
    if (lower.includes(phrase.toLowerCase()) || text.includes(phrase)) {
      warnings.push({
        code: "phrase",
        messageJa: `文面に「${phrase}」があります。公開してよい内容か確認してください。`,
        detail: phrase,
      });
    }
  }
  const urls = text.match(URL_RE) ?? [];
  for (const raw of urls) {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (!host || !ALLOWED_HOSTS.has(host)) {
      warnings.push({
        code: "url",
        messageJa: "許可したドメイン以外の URL があります。公開してよい内容か確認してください。",
        detail: raw.slice(0, 120),
      });
    }
  }
  return { blocking: false, warnings };
}
