/**
 * MAIL_UNVERIFIED_FROM_ENABLED (default OFF): welcome / trial_started only
 * may use EMAIL_FROM_UNVERIFIED. Flag ON + env missing → refuse (no fallback).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_LABEL } from "./brand";
import { isMailUnverifiedFromEnabled } from "./feature-flags";
import {
  getEmailFrom,
  resolveTransactionalFrom,
  sendTransactionalEmail,
} from "./resend";
import {
  sendApprovalNeededEmail,
  sendBillingEmail,
  sendTrialStartedEmail,
  sendWelcomeEmail,
} from "./email";

const ROOT = process.cwd();

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function snapshotEnv() {
  return {
    MAIL_UNVERIFIED_FROM_ENABLED: process.env.MAIL_UNVERIFIED_FROM_ENABLED,
    EMAIL_FROM_UNVERIFIED: process.env.EMAIL_FROM_UNVERIFIED,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
}

afterEach(() => {
  delete process.env.MAIL_UNVERIFIED_FROM_ENABLED;
  delete process.env.EMAIL_FROM_UNVERIFIED;
  delete process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
});

describe("MAIL_UNVERIFIED_FROM_ENABLED 既定 OFF", () => {
  test("フラグは既定 OFF", () => {
    delete process.env.MAIL_UNVERIFIED_FROM_ENABLED;
    expect(isMailUnverifiedFromEnabled()).toBe(false);
  });

  test("getEmailFrom は EMAIL_FROM のみを見る（未確認用には触れない）", () => {
    const saved = snapshotEnv();
    try {
      process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
      process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
      process.env.EMAIL_FROM_UNVERIFIED = "Unverified <noreply@unverified.example>";
      expect(getEmailFrom()).toBe("Prod <noreply@prod.example>");
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("resolveTransactionalFrom", () => {
  test("audience 省略 / verified は EMAIL_FROM（または既定）", () => {
    delete process.env.EMAIL_FROM;
    expect(resolveTransactionalFrom()).toEqual({
      ok: true,
      from: `${SERVICE_LABEL} <noreply@example.com>`,
    });
    expect(resolveTransactionalFrom("verified")).toEqual({
      ok: true,
      from: `${SERVICE_LABEL} <noreply@example.com>`,
    });
  });

  test("フラグ OFF の unverified は本番 From に落とす（今日と同じ）", () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    delete process.env.MAIL_UNVERIFIED_FROM_ENABLED;
    process.env.EMAIL_FROM_UNVERIFIED = "Unverified <noreply@unverified.example>";
    expect(resolveTransactionalFrom("unverified")).toEqual({
      ok: true,
      from: "Prod <noreply@prod.example>",
    });
  });

  test("フラグ ON + EMAIL_FROM_UNVERIFIED あり → 未確認 From", () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
    process.env.EMAIL_FROM_UNVERIFIED = "Unverified <noreply@unverified.example>";
    expect(resolveTransactionalFrom("unverified")).toEqual({
      ok: true,
      from: "Unverified <noreply@unverified.example>",
    });
    expect(resolveTransactionalFrom("verified")).toEqual({
      ok: true,
      from: "Prod <noreply@prod.example>",
    });
  });

  test("フラグ ON + EMAIL_FROM_UNVERIFIED 未設定 → fail-closed（本番 From に戻さない）", () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "1";
    delete process.env.EMAIL_FROM_UNVERIFIED;
    expect(resolveTransactionalFrom("unverified")).toEqual({
      ok: false,
      error: "unverified_from_unconfigured",
    });
  });

  test("フラグ ON + EMAIL_FROM_UNVERIFIED が空白のみ → fail-closed", () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "on";
    process.env.EMAIL_FROM_UNVERIFIED = "   ";
    expect(resolveTransactionalFrom("unverified")).toEqual({
      ok: false,
      error: "unverified_from_unconfigured",
    });
  });
});

describe("sendTransactionalEmail audience", () => {
  test("welcome / trial_started は未確認。フラグ ON・env なしなら送らずログする", async () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
    delete process.env.EMAIL_FROM_UNVERIFIED;
    delete process.env.RESEND_API_KEY;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const welcome = await sendWelcomeEmail("third@example.invalid", "株式会社サンプル");
      const trial = await sendTrialStartedEmail("third@example.invalid", 14);
      expect(welcome).toEqual({ ok: false, error: "unverified_from_unconfigured" });
      expect(trial).toEqual({ ok: false, error: "unverified_from_unconfigured" });
      expect(welcome.stub).toBeUndefined();
      expect(trial.stub).toBeUndefined();
      expect(warnings.some((w) => w.includes("unverified_from_unconfigured"))).toBe(true);
      expect(warnings.join("\n")).not.toContain("third@example.invalid");
    } finally {
      console.warn = warn;
    }
  });

  test("フラグ ON・env ありなら welcome / trial は stub 送信する（実送信しない）", async () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
    process.env.EMAIL_FROM_UNVERIFIED = "Unverified <noreply@unverified.example>";
    delete process.env.RESEND_API_KEY;
    const welcome = await sendWelcomeEmail("third@example.invalid", "例");
    const trial = await sendTrialStartedEmail("third@example.invalid", 14);
    expect(welcome.ok).toBe(true);
    expect(welcome.stub).toBe(true);
    expect(trial.ok).toBe(true);
    expect(trial.stub).toBe(true);
  });

  test("承認・課金はフラグ ON・env なしでも EMAIL_FROM から stub 送信する", async () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
    delete process.env.EMAIL_FROM_UNVERIFIED;
    delete process.env.RESEND_API_KEY;
    const approval = await sendApprovalNeededEmail("ops@example.invalid", "要約", "high");
    const billing = await sendBillingEmail("ops@example.invalid", "請求", "<p>ok</p>");
    expect(approval.ok).toBe(true);
    expect(approval.stub).toBe(true);
    expect(billing.ok).toBe(true);
    expect(billing.stub).toBe(true);
  });

  test("verified の直接呼び出しは未確認 From を使わない", async () => {
    process.env.EMAIL_FROM = "Prod <noreply@prod.example>";
    process.env.MAIL_UNVERIFIED_FROM_ENABLED = "true";
    process.env.EMAIL_FROM_UNVERIFIED = "Unverified <noreply@unverified.example>";
    delete process.env.RESEND_API_KEY;
    const sent = await sendTransactionalEmail({
      to: "ops@example.invalid",
      template: "approval_needed",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(sent.ok).toBe(true);
    expect(sent.stub).toBe(true);
    expect(resolveTransactionalFrom("verified").ok && resolveTransactionalFrom("verified").from).toBe(
      "Prod <noreply@prod.example>"
    );
  });
});

describe("配線", () => {
  test("sendWelcomeEmail / sendTrialStartedEmail だけ audience unverified を渡す", () => {
    const email = readFileSync(join(ROOT, "lib/email.ts"), "utf8");
    expect(email).toMatch(/sendWelcomeEmail[\s\S]*audience:\s*"unverified"/);
    expect(email).toMatch(/sendTrialStartedEmail[\s\S]*audience:\s*"unverified"/);
    expect(email).not.toMatch(/sendTrialEndingEmail[\s\S]*audience:\s*"unverified"/);
    expect(email).not.toMatch(/sendApprovalNeededEmail[\s\S]*audience:\s*"unverified"/);
    expect(email).not.toMatch(/sendBillingEmail[\s\S]*audience:\s*"unverified"/);
  });

  test("no-network は EMAIL_FROM_UNVERIFIED を落とす", () => {
    const src = readFileSync(join(ROOT, "tests/security/no-network.ts"), "utf8");
    expect(src).toContain('"EMAIL_FROM_UNVERIFIED"');
  });

  test(".env.example にフラグと未確認 From がある（既定はコメント / OFF）", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("MAIL_UNVERIFIED_FROM_ENABLED");
    expect(env).toContain("EMAIL_FROM_UNVERIFIED");
    expect(env).not.toMatch(/^MAIL_UNVERIFIED_FROM_ENABLED=true/m);
  });
});
