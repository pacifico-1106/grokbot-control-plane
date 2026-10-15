import { createHash } from "node:crypto";

/** Trim + LF newlines. Used for body_hash of the three body fields. */
export function normalizeNoticeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function noticeBodyHash(input: {
  title: string;
  changeSummary: string;
  aiUsageChange: string;
}): string {
  const payload = JSON.stringify({
    title: normalizeNoticeBody(input.title),
    changeSummary: normalizeNoticeBody(input.changeSummary),
    aiUsageChange: normalizeNoticeBody(input.aiUsageChange),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
