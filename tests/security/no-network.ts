import { afterAll, expect, mock } from "bun:test";
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns/promises";

// Preloaded for EVERY `bun test` in this repo (bunfig.toml) and by scripts/test-local.mjs.
// 木村 10/12 09:01: a direct `bun test <file>` inherited the box env and posted real
// 「緊急停止に失敗しました」 messages to Slack. So, before any test module loads:
//
// 1. Delete every outbound-notify env var (exact list + pattern), so no code path even
//    has a destination. Tests that need one set a fake value themselves.
const NOTIFY_ENV_EXACT = [
  "LP_HANDOFF_NOTIFY_SLACK_WEBHOOK", "APPROVAL_ALERT_OPS_EMAILS", "BILLING_NOTIFY_EMAIL", "RESEND_API_KEY",
  "TOMORI_WAKE_WEBHOOK_URL", "TOMORI_WAKE_WEBHOOK_SECRET", "SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL",
  "TELEGRAM_BOT_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN", "SENDGRID_API_KEY", "POSTMARK_API_TOKEN", "MAILGUN_API_KEY",
  "TWILIO_AUTH_TOKEN", "DISCORD_WEBHOOK_URL", "SMTP_URL", "SMTP_PASSWORD",
];
const NOTIFY_ENV_PATTERN =
  /WEBHOOK|ALERT|NOTIFY|RESEND|SENDGRID|POSTMARK|MAILGUN|SMTP|TWILIO|DISCORD|TELEGRAM|^SLACK_|_SLACK_|LINE_CHANNEL|OPS_EMAIL/i;
for (const key of Object.keys(process.env)) {
  if (NOTIFY_ENV_EXACT.includes(key) || NOTIFY_ENV_PATTERN.test(key)) delete process.env[key];
}

// 2. Accidental network cannot reach real services, even if application code catches the
//    error: every un-mocked fetch / http(s).request / DNS lookup throws (naming the host)
//    and the file fails in afterAll. Tests that need fetch replace globalThis.fetch.
let attempted: string[] = [];
function hostOf(input: unknown): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? String(input);
    return new URL(raw).host || "?";
  } catch {
    return typeof input === "object" && input && "host" in input ? String((input as { host?: unknown }).host) : "?";
  }
}
function refuse(target: unknown): never {
  const host = hostOf(target);
  attempted.push(host);
  console.error(`\n[no-network] REFUSED real network call to ${host} — mock it in the test.\n`);
  throw new Error(`network_forbidden_in_local_tests: ${host}`);
}
globalThis.fetch = ((input: unknown) => refuse(input)) as unknown as typeof fetch;
(globalThis as { __STAFFPASS_NETWORK_GUARD__?: boolean }).__STAFFPASS_NETWORK_GUARD__ = true;
// for the harness probe only (lib/security/test-network-guard.test.ts)
(globalThis as { __STAFFPASS_NETWORK_ATTEMPTS_RESET__?: () => void }).__STAFFPASS_NETWORK_ATTEMPTS_RESET__ = () => {
  attempted = [];
};
const forbidden = (target: unknown) => refuse(typeof target === "object" && target && "hostname" in target
  ? `https://${(target as { hostname?: string }).hostname}` : target);
mock.module("node:https", () => ({ ...https, request: forbidden, get: forbidden }));
mock.module("node:http", () => ({ ...http, request: forbidden, get: forbidden }));
mock.module("node:dns/promises", () => ({ ...dns, lookup: forbidden }));
afterAll(() => {
  expect(attempted).toEqual([]);
});

// Server-only is a build boundary; fixture tests run server modules deliberately.
mock.module("server-only", () => ({}));
