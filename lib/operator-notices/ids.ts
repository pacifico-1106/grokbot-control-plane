/**
 * Notice / feedback ids: prefix + 26-char Crockford ULID (uppercase).
 * Matches migration 20261015100000 check constraints.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = now;
  const chars: string[] = new Array(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let entropy = 0n;
  for (const b of bytes) entropy = (entropy << 8n) | BigInt(b);
  for (let i = 25; i >= 10; i--) {
    chars[i] = CROCKFORD[Number(entropy & 31n)];
    entropy >>= 5n;
  }
  return chars.join("");
}

export function newNoticeId(): string {
  return `ntc_${ulid()}`;
}

export function newFeedbackItemId(): string {
  return `fb_${ulid()}`;
}

const NOTICE_ID_RE = /^ntc_[0-9A-HJKMNP-TV-Z]{26}$/;
const FEEDBACK_ID_RE = /^fb_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isNoticeId(value: string): boolean {
  return NOTICE_ID_RE.test(value);
}

export function isFeedbackItemId(value: string): boolean {
  return FEEDBACK_ID_RE.test(value);
}
