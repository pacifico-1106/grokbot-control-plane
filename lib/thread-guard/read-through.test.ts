/**
 * Thread single-flight (木村 10/9 A / triage #2): the point the AI read the
 * thread through. Explicit `readThroughTs` (body, conversation or payload) wins;
 * otherwise the inbound message ts the AI was woken by (conversation.ts /
 * messageTs). Slack ts, epoch seconds / ms and ISO 8601 are accepted; a value
 * in the future (beyond a small skew) is ignored so it cannot switch the check
 * off. Pure functions.
 */
import { describe, expect, test } from "bun:test";
import { microsToTs, parseThreadTimestamp, readThroughFromBody, readThroughFromSnapshot } from "./read-through";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const NOW_S = Math.floor(NOW / 1000);

describe("parseThreadTimestamp", () => {
  test("Slack ts keeps microseconds exactly", () => {
    expect(parseThreadTimestamp("1791105000.000001")).toBe(BigInt(1791105000000001));
    expect(parseThreadTimestamp("1791105000.5")).toBe(BigInt(1791105000500000));
    expect(microsToTs(BigInt(1791105000000001))).toBe("1791105000.000001");
  });
  test("epoch seconds / milliseconds / ISO", () => {
    expect(parseThreadTimestamp("1791105000")).toBe(BigInt(1791105000000000));
    expect(parseThreadTimestamp(1791105000123)).toBe(BigInt(1791105000123000));
    expect(parseThreadTimestamp("2026-10-09T12:00:00.000Z")).toBe(BigInt(NOW) * BigInt(1000));
  });
  test("garbage → null", () => {
    for (const v of ["", "abc", "12", "-1791105000.1", null, undefined, {}, "1791105000.1234567"]) {
      expect(parseThreadTimestamp(v)).toBeNull();
    }
  });
});

describe("readThroughFromBody", () => {
  test("explicit wins (top level, conversation, payload) over the inbound ts", () => {
    const inbound = { surface: "slack", ts: `${NOW_S - 50}.000100` };
    expect(readThroughFromBody({ readThroughTs: `${NOW_S - 10}.000001`, conversation: inbound }, NOW)).toMatchObject({
      source: "explicit",
      ts: `${NOW_S - 10}.000001`,
    });
    expect(readThroughFromBody({ conversation: { ...inbound, readThroughTs: `${NOW_S - 20}.000001` } }, NOW)?.source).toBe("explicit");
    expect(readThroughFromBody({ args: { readThroughTs: `${NOW_S - 30}.000001` }, conversation: inbound }, NOW)?.ts).toBe(`${NOW_S - 30}.000001`);
  });
  test("no explicit → the inbound message ts", () => {
    expect(readThroughFromBody({ conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)).toMatchObject({
      source: "inbound",
      ts: `${NOW_S - 50}.000100`,
    });
    expect(readThroughFromBody({ conversation: { messageTs: `${NOW_S - 5}.000001` } }, NOW)?.source).toBe("inbound");
  });
  test("future explicit value (beyond 120 s skew) is ignored → inbound / none", () => {
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 3600}.000000`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)?.source).toBe("inbound");
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 3600}.000000` }, NOW)).toBeNull();
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 60}.000000` }, NOW)?.source).toBe("explicit");
  });
  test("nothing → null (lease only)", () => {
    expect(readThroughFromBody({}, NOW)).toBeNull();
  });
});

describe("readThroughFromSnapshot (fulfil)", () => {
  test("recorded readThroughTs, else the snapshot's inbound ts", () => {
    expect(readThroughFromSnapshot({ readThroughTs: `${NOW_S - 10}.000001`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)?.source).toBe("explicit");
    expect(readThroughFromSnapshot({ conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)?.source).toBe("inbound");
    expect(readThroughFromSnapshot({ conversation: null }, NOW)).toBeNull();
  });
});
