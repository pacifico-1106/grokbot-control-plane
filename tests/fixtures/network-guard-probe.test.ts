/**
 * Probe run by lib/security/test-network-guard.test.ts as a plain `bun test <file>`
 * (no --preload flag, parent env carrying fake notify values). It must see the
 * repo-wide preload (bunfig.toml): notify env deleted, fetch guarded. It never
 * performs a request unless the guard marker is present.
 */
import { expect, test } from "bun:test";

const NOTIFY_KEYS = [
  "LP_HANDOFF_NOTIFY_SLACK_WEBHOOK", "APPROVAL_ALERT_OPS_EMAILS", "BILLING_NOTIFY_EMAIL", "RESEND_API_KEY",
  "TOMORI_WAKE_WEBHOOK_URL", "SLACK_BOT_TOKEN", "SOME_NEW_SLACK_ALERT_WEBHOOK", "TELEGRAM_BOT_TOKEN",
];

test("probe: notify env stripped and fetch guarded", async () => {
  const guarded = (globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__ === true;
  const leftover = NOTIFY_KEYS.filter((k) => process.env[k] !== undefined);
  console.log(`PROBE guarded=${guarded} leftover=${leftover.join(",") || "-"}`);
  expect(guarded).toBe(true);
  expect(leftover).toEqual([]);
  // only now is it safe to call fetch: the guard must refuse loudly, naming the host
  let message = "";
  try {
    await fetch("https://hooks.slack.com/services/T000/B000/probe");
  } catch (e) {
    message = String((e as Error).message);
  }
  expect(message).toContain("network_forbidden_in_local_tests");
  expect(message).toContain("hooks.slack.com");
  (globalThis as { __STAFFPASS_NETWORK_ATTEMPTS_RESET__?: () => void }).__STAFFPASS_NETWORK_ATTEMPTS_RESET__?.();
});
