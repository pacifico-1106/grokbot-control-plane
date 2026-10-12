/**
 * Fixture for lib/security/test-network-guard.test.ts: code that catches the network
 * error (as fire-and-forget notifiers do). The guard must still fail this file.
 * Target is a fake path; the guard refuses before any connection.
 */
import { expect, test } from "bun:test";

test("swallowed fetch", async () => {
  // Never touch the network without the guard (fails on a checkout without it).
  expect((globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__).toBe(true);
  try {
    await fetch("https://hooks.slack.com/services/T000/B000/swallowed");
  } catch {
    // a notifier that never throws
  }
});
