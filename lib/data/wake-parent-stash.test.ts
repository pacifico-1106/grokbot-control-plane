import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  storeWakeParent,
  lookupWakeParent,
  consumeWakeParent,
  clearStash,
  getStashSize,
  cleanupExpiredEntries,
  WAKE_PARENT_STASH_TTL_MS,
} from "./wake-parent-stash";

describe("Wake Parent Stash", () => {
  beforeEach(() => {
    clearStash();
  });

  test("stores and retrieves wake parent entry", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(entry).not.toBeNull();
    expect(entry?.parentTs).toBe("1789746322.045839");
    expect(entry?.eventId).toBe("Ev0C30P93BQC");
    expect(entry?.orgId).toBe("org_test");
    expect(entry?.employeeId).toBe("emp_test");
    expect(entry?.channelId).toBe("C_CHANNEL");
  });

  test("returns null for non-existent entry", () => {
    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_nonexistent",
      channelId: "C_CHANNEL",
    });

    expect(entry).toBeNull();
  });

  test("tenant isolation: different orgId returns null", () => {
    storeWakeParent({
      orgId: "org_a",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    const entry = lookupWakeParent({
      orgId: "org_b",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(entry).toBeNull();
  });

  test("different employeeId returns null", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_a",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_b",
      channelId: "C_CHANNEL",
    });

    expect(entry).toBeNull();
  });

  test("different channelId returns null", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL_A",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL_B",
    });

    expect(entry).toBeNull();
  });

  test("consume removes entry and returns it", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    const consumed = consumeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(consumed).not.toBeNull();
    expect(consumed?.parentTs).toBe("1789746322.045839");

    // Entry should be gone after consume
    const lookup = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(lookup).toBeNull();
  });

  test("lookup does not remove entry", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    // First lookup
    const first = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });
    expect(first).not.toBeNull();

    // Second lookup should also succeed
    const second = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });
    expect(second).not.toBeNull();
  });

  test("overwrites existing entry for same key", () => {
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev_first",
    });

    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746400.000000",
      eventId: "Ev_second",
    });

    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(entry?.parentTs).toBe("1789746400.000000");
    expect(entry?.eventId).toBe("Ev_second");
  });

  test("getStashSize returns correct count", () => {
    expect(getStashSize()).toBe(0);

    storeWakeParent({
      orgId: "org_a",
      employeeId: "emp_1",
      channelId: "C_1",
      parentTs: "1.0",
      eventId: "Ev1",
    });
    expect(getStashSize()).toBe(1);

    storeWakeParent({
      orgId: "org_a",
      employeeId: "emp_2",
      channelId: "C_1",
      parentTs: "2.0",
      eventId: "Ev2",
    });
    expect(getStashSize()).toBe(2);

    // Same key overwrites, shouldn't increase count
    storeWakeParent({
      orgId: "org_a",
      employeeId: "emp_1",
      channelId: "C_1",
      parentTs: "1.1",
      eventId: "Ev1b",
    });
    expect(getStashSize()).toBe(2);
  });

  test("clearStash removes all entries", () => {
    storeWakeParent({
      orgId: "org_a",
      employeeId: "emp_1",
      channelId: "C_1",
      parentTs: "1.0",
      eventId: "Ev1",
    });
    storeWakeParent({
      orgId: "org_b",
      employeeId: "emp_2",
      channelId: "C_2",
      parentTs: "2.0",
      eventId: "Ev2",
    });

    expect(getStashSize()).toBe(2);

    clearStash();

    expect(getStashSize()).toBe(0);
  });

  test("TTL constant is 15 minutes", () => {
    expect(WAKE_PARENT_STASH_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("Wake Parent Stash expiry behavior", () => {
  beforeEach(() => {
    clearStash();
  });

  test("expired entry returns null on lookup", () => {
    const originalDateNow = Date.now;

    // Store entry at time 0
    Date.now = () => 0;
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    // Entry should exist at time 0
    const existsNow = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });
    expect(existsNow).not.toBeNull();

    // Move time past TTL (15 min + 1 ms)
    Date.now = () => WAKE_PARENT_STASH_TTL_MS + 1;

    const entry = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(entry).toBeNull();

    Date.now = originalDateNow;
  });

  test("expired entry returns null on consume", () => {
    const originalDateNow = Date.now;

    Date.now = () => 0;
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
      parentTs: "1789746322.045839",
      eventId: "Ev0C30P93BQC",
    });

    // Move time past TTL
    Date.now = () => WAKE_PARENT_STASH_TTL_MS + 1;

    const consumed = consumeWakeParent({
      orgId: "org_test",
      employeeId: "emp_test",
      channelId: "C_CHANNEL",
    });

    expect(consumed).toBeNull();

    Date.now = originalDateNow;
  });

  test("cleanupExpiredEntries removes expired entries", () => {
    const originalDateNow = Date.now;

    // Store two entries at different times
    Date.now = () => 0;
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_1",
      channelId: "C_1",
      parentTs: "1.0",
      eventId: "Ev1",
    });

    Date.now = () => WAKE_PARENT_STASH_TTL_MS / 2;
    storeWakeParent({
      orgId: "org_test",
      employeeId: "emp_2",
      channelId: "C_2",
      parentTs: "2.0",
      eventId: "Ev2",
    });

    expect(getStashSize()).toBe(2);

    // Move time so first entry is expired but second is not
    Date.now = () => WAKE_PARENT_STASH_TTL_MS + 1;

    const cleaned = cleanupExpiredEntries();
    expect(cleaned).toBe(1);
    expect(getStashSize()).toBe(1);

    // First entry should be gone
    const first = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_1",
      channelId: "C_1",
    });
    expect(first).toBeNull();

    // Second entry should still exist
    const second = lookupWakeParent({
      orgId: "org_test",
      employeeId: "emp_2",
      channelId: "C_2",
    });
    expect(second).not.toBeNull();

    Date.now = originalDateNow;
  });
});
