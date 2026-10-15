/**
 * Notice / feedback ids: prefix + 26-char Crockford ULID (uppercase).
 * Matches migration 20261015100000 check constraints.
 * No BigInt (tsconfig target is ES2017).
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
  // 10 bytes = 80 bits → 16 Crockford chars. Bitstream, number-sized buffer.
  let bitBuf = 0;
  let bitCount = 0;
  let idx = 10;
  for (const b of bytes) {
    bitBuf = (bitBuf << 8) | b;
    bitCount += 8;
    while (bitCount >= 5 && idx < 26) {
      bitCount -= 5;
      chars[idx++] = CROCKFORD[(bitBuf >>> bitCount) & 31];
    }
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
