import { describe, expect, test } from "bun:test";
import { isFeedbackItemId, isNoticeId, newFeedbackItemId, newNoticeId, ulid } from "./ids";

describe("operator notice ids", () => {
  test("ulid is 26 Crockford chars; notice / feedback prefixes match the SQL checks", () => {
    expect(ulid(0)).toHaveLength(26);
    expect(ulid(0)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const n = newNoticeId();
    expect(n.startsWith("ntc_")).toBe(true);
    expect(isNoticeId(n)).toBe(true);
    expect(isNoticeId(n.toLowerCase())).toBe(false);
    expect(isFeedbackItemId(newFeedbackItemId())).toBe(true);
  });
});
