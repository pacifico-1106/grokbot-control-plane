/**
 * 木村 10/12 09:01: test runs on the box posted real 「緊急停止に失敗しました」 messages to
 * #staffpass-consultation because a direct `bun test <file>` inherited the box env
 * (LP_HANDOFF_NOTIFY_SLACK_WEBHOOK) and had no network guard. Every bun test run in
 * this repo — npm test or a direct `bun test` — must delete outbound-notify env and
 * refuse real network.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FAKE_ENV = {
  LP_HANDOFF_NOTIFY_SLACK_WEBHOOK: "https://hooks.slack.com/services/T000/B000/fake",
  APPROVAL_ALERT_OPS_EMAILS: "ops@example.invalid",
  BILLING_NOTIFY_EMAIL: "billing@example.invalid",
  RESEND_API_KEY: "re_fake_0000",
  TOMORI_WAKE_WEBHOOK_URL: "https://wake.example.invalid/hook",
  SLACK_BOT_TOKEN: "xoxb-fake",
  SOME_NEW_SLACK_ALERT_WEBHOOK: "https://hooks.slack.com/services/T000/B000/new",
  TELEGRAM_BOT_TOKEN: "000:fake",
};

describe("test harness: no outbound notify from any bun test run", () => {
  test("bunfig.toml preloads the guard for every `bun test`", () => {
    expect(existsSync(join(ROOT, "bunfig.toml"))).toBe(true);
    expect(readFileSync(join(ROOT, "bunfig.toml"), "utf8")).toMatch(/preload\s*=\s*\[[^\]]*tests\/security\/no-network\.ts/);
  });

  test("a direct `bun test <file>` with notify env set: env deleted, fetch refused", () => {
    const bun = process.execPath;
    const r = spawnSync(bun, ["test", "./tests/fixtures/network-guard-probe.test.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...FAKE_ENV } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain("PROBE guarded=true leftover=-");
    expect(r.status).toBe(0);
  });
});
