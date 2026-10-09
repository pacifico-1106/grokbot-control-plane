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
import { READ_THROUGH_FUTURE_SKEW_SECONDS } from "./config";

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
  test("future explicit value (beyond the few-second skew) is ignored → inbound / none", () => {
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 3600}.000000`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)?.source).toBe("inbound");
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 3600}.000000` }, NOW)).toBeNull();
  });
  // 木村 #286 pre-flag item 1: the accepted future window was 120 s, so a
  // value ~2 minutes ahead of "now" was taken as the read point and a stale
  // approved send skipped the moved_on check at fulfil.
  test("pre-flag 1: the future window is a few seconds, not 120 s", () => {
    expect(READ_THROUGH_FUTURE_SKEW_SECONDS).toBeLessThanOrEqual(5);
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 60}.000000`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)).toMatchObject({
      source: "inbound",
      ts: `${NOW_S - 50}.000100`,
    });
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 60}.000000` }, NOW)).toBeNull();
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 119}.000000` }, NOW)).toBeNull();
  });
  test("pre-flag 1: a value later than the inbound ts (inside the skew) is capped at the receive time", () => {
    const capped = readThroughFromBody({ readThroughTs: `${NOW_S + 3}.000000`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW);
    expect(capped).toMatchObject({ source: "explicit", ts: `${NOW_S}.000000` });
    expect(capped?.micros).toBe(BigInt(NOW) * BigInt(1000));
    // no inbound ts at all: the same cap
    expect(readThroughFromBody({ readThroughTs: `${NOW_S + 2}.500000` }, NOW)?.ts).toBe(`${NOW_S}.000000`);
    // an inbound ts itself never reaches past the receive time either
    expect(readThroughFromBody({ conversation: { ts: `${NOW_S + 4}.000000` } }, NOW)?.ts).toBe(`${NOW_S}.000000`);
    // a value before the receive time is kept as is
    expect(readThroughFromBody({ readThroughTs: `${NOW_S - 1}.000007`, conversation: { ts: `${NOW_S - 50}.000100` } }, NOW)?.ts).toBe(`${NOW_S - 1}.000007`);
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
  test("pre-flag 1: judged against the time the approval was received (createdAt), never the fulfil-time clock", () => {
    const createdAt = NOW - 30 * 60_000; // approved 30 minutes later
    const createdS = Math.floor(createdAt / 1000);
    // a read point a minute past the request: ignored (inbound used), even though fulfil-time "now" is later
    expect(readThroughFromSnapshot({ readThroughTs: `${createdS + 60}.000000`, conversation: { ts: `${createdS - 50}.000100` } }, createdAt)).toMatchObject({
      source: "inbound",
      ts: `${createdS - 50}.000100`,
    });
    // inside the skew: capped at the receive time
    expect(readThroughFromSnapshot({ readThroughTs: `${createdS + 3}.000000` }, createdAt)?.ts).toBe(`${createdS}.000000`);
    expect(readThroughFromSnapshot({ conversation: { ts: `${createdS + 3}.000000` } }, createdAt)?.ts).toBe(`${createdS}.000000`);
  });
});
