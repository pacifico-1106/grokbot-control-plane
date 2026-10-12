/**
 * 木村 10/12: test runs on the box posted real messages to the ops Slack channel,
 * because a direct `bun test <file>` inherited the box env (real
 * LP_HANDOFF_NOTIFY_SLACK_WEBHOOK) with no network guard. Every bun test run in this
 * repo, npm test or a direct `bun test`, must delete outbound-notify / outbound-
 * credential env and refuse real network (fetch, node:http(s), node:net / tls, DNS,
 * undici), naming the host only.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// FAKE values only. Shapes of the real ones, so a pattern-based scrub is exercised.
const FAKE_ENV: Record<string, string> = {
  LP_HANDOFF_NOTIFY_SLACK_WEBHOOK: "https://hooks.slack.com/services/T000/B000/fake",
  APPROVAL_ALERT_OPS_EMAILS: "ops@example.invalid",
  BILLING_NOTIFY_EMAIL: "billing@example.invalid",
  RESEND_API_KEY: "re_fake_0000",
  APPROVAL_NOTIFY_EMAIL: "approver@example.invalid",
  AI_EMP_INQUIRY_NOTIFY_EMAIL: "inquiry@example.invalid",
  LP_HANDOFF_NOTIFY_EMAIL: "handoff@example.invalid",
  APPROVAL_DELIVERY_FAILURE_ALERT: "true",
  TOMORI_WAKE_WEBHOOK_URL: "https://wake.example.invalid/hook",
  TOMORI_WAKE_WEBHOOK_SECRET: "fake",
  SLACK_CLIENT_SECRET: "fake",
  SLACK_SIGNING_SECRET: "fake",
  SLACK_SHARED_APPROVAL_CLIENT_SECRET: "fake",
  SLACK_SHARED_APPROVAL_SIGNING_SECRET: "fake",
  SOME_NEW_SLACK_ALERT_WEBHOOK: "https://hooks.slack.com/services/T000/B000/new",
  TELEGRAM_BOT_TOKEN: "000:fake",
  TELEGRAM_WEBHOOK_SECRET: "fake",
  LINE_CHANNEL_ACCESS_TOKEN: "fake",
  LINE_WORKS_BOT_SECRET: "fake",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  SUPABASE_SERVICE_ROLE_KEY: "fake",
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake",
  OPENAI_API_KEY: "sk-fake",
  GITHUB_TOKEN: "ghp_fake",
  DEMO_APPROVALS_GITHUB_TOKEN: "ghp_fake",
  VERCEL_TOKEN: "fake",
  KV_REST_API_TOKEN: "fake",
  KV_REST_API_URL: "https://kv.example.invalid",
  UPSTASH_REDIS_REST_TOKEN: "fake",
  UPSTASH_REDIS_REST_URL: "https://redis.example.invalid",
  SEALITH_AUTHORITY_EVENTS_URL: "https://sealith.example.invalid/events",
  SEALITH_STAFFPASS_EVENT_SECRET: "fake",
  STAFFPASS_SEALITH_EVENT_SECRET: "fake",
  APPROVAL_DEMO_STORE_URL: "https://store.example.invalid",
  APPROVAL_DEMO_STORE_TOKEN: "fake",
  TURNSTILE_SECRET_KEY: "fake",
  GOOGLE_OAUTH_CLIENT_SECRET: "fake",
  TWOCAPTCHA_API_KEY: "fake",
  SMTP_PASSWORD: "fake",
};

describe("test harness: no outbound notify / network from any bun test run", () => {
  test("bunfig.toml preloads the guard for every `bun test`", () => {
    expect(existsSync(join(ROOT, "bunfig.toml"))).toBe(true);
    expect(readFileSync(join(ROOT, "bunfig.toml"), "utf8")).toMatch(/preload\s*=\s*\[[^\]]*tests\/security\/no-network\.ts/);
  });

  test("a direct `bun test <file>` with notify / credential env set: env deleted, hooks.slack.com and every other path refused", () => {
    const r = spawnSync(process.execPath, ["test", "./tests/fixtures/network-guard-probe.test.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...FAKE_ENV,
        PROBE_EXPECT_SCRUBBED: Object.keys(FAKE_ENV).join(","),
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain("PROBE guarded=true leftover=-");
    expect(r.status).toBe(0);
    // host only: a webhook path / token never appears in the refusal output
    expect(out).not.toContain("/services/T000");
  });

  test("an un-mocked network call fails the file loudly even if the code under test swallows the error", () => {
    const r = spawnSync(process.execPath, ["test", "./tests/fixtures/network-guard-swallowed.test.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out).toContain("REFUSED real network call to hooks.slack.com");
  });
});
