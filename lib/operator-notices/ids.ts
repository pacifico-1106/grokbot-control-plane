/** ntc_ / fb_ ids (Crockford base32 ULID, 26 chars) and the body hash (design §2.1). */
import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}
export const newNoticeId = () => `ntc_${ulid()}`;
export const newFeedbackId = () => `fb_${ulid()}`;
export const NOTICE_ID_RE = /^ntc_[0-9A-HJKMNP-TV-Z]{26}$/;
export const FEEDBACK_ID_RE = /^fb_[0-9A-HJKMNP-TV-Z]{26}$/;

/** sha256 over the three body fields, NFC + trimmed + CRLF→LF, field-separated. */
export function noticeBodyHash(b: { title: string; changeSummary: string; aiUsageChange: string }): string {
  const norm = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return createHash("sha256").update([norm(b.title), norm(b.changeSummary), norm(b.aiUsageChange)].join("\u0000")).digest("hex");
}
