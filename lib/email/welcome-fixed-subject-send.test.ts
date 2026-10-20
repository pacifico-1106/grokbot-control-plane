/**
 * WELCOME_MAIL_FIXED_SUBJECT_ENABLED — send layer (not templates).
 * Captures the subject/html that sendWelcomeEmail / sendTrialStartedEmail /
 * sendTrialEndingEmail pass through sendTransactionalEmail (after
 * sanitizeEmailSubject, which is what would go on the wire).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml, sanitizeEmailSubject } from "@/lib/html-escape";

type CapturedMail = {
  to: unknown;
  template: string;
  subject: string;
  html: string;
};

const sent: CapturedMail[] = [];

const realResend = await import("@/lib/resend");
mock.module("@/lib/resend", () => ({
  ...realResend,
  sendTransactionalEmail: async (input: {
    to: unknown;
    template: string;
    subject: string;
    html: string;
  }) => {
    sent.push({
      to: input.to,
      template: input.template,
      subject: sanitizeEmailSubject(input.subject),
      html: String(input.html ?? ""),
    });
    return { ok: true, stub: true, id: "stub_welcome_fixed_subject" };
  },
}));

const realMode = await import("@/lib/mode");
mock.module("@/lib/mode", () => ({
  ...realMode,
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
}));

function supabaseAdmin() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.ilike = self;
  chain.eq = self;
  chain.limit = self;
  chain.maybeSingle = async () => ({ data: null, error: null });
  return {
    from: () => chain,
    auth: {
      admin: {
        createUser: async () => ({ data: { user: { id: "user_dirty" } }, error: null }),
      },
    },
  };
}

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => supabaseAdmin(),
  createSupabaseBrowserClient: () => null,
  createSupabaseServerClient: () => null,
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
}));

const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  provisionOrgForUser: async () => ({
    orgId: "org_dirty",
    memberId: "mem_dirty",
    member: { id: "mem_dirty" },
  }),
}));

const realOrg = await import("@/lib/data/org-context");
mock.module("@/lib/data/org-context", () => ({
  ...realOrg,
  getOrgMeta: async () => ({
    id: "org_dirty",
    name: "n",
    integrationMode: "managed" as const,
    gatewayStatus: "pending" as const,
    trialEndsAt: "2026-12-01T00:00:00.000Z",
    referralCode: null,
  }),
}));

const { sendTrialEndingEmail, sendTrialStartedEmail, sendWelcomeEmail } = await import("@/lib/email");
const { platformCreateOrg } = await import("@/lib/admin-mcp/orgs-create");
const {
  TRIAL_ENDING_FIXED_SUBJECT,
  TRIAL_STARTED_FIXED_SUBJECT,
  WELCOME_MAIL_FIXED_SUBJECT,
} = await import("@/lib/email-templates");

/** main `b40aaa39` の件名 + 本文（escapeHtml のみ）。 */
function mainEraWelcome(orgName: string) {
  const org = escapeHtml(orgName);
  return {
    subject: sanitizeEmailSubject(`ようこそ — ${orgName} の AI社員 制御面`),
    html: realResend.renderStubHtml(
      "ようこそ",
      `<p>${org} 様の制御面を準備しました。</p>
       <p>次のステップ:</p>
       <ol>
         <li>はじめに チェックリストを開く</li>
         <li>最初の AI社員を雇う（職務を日本語で説明 → Draft → 社員証発行）</li>
         <li>Grok Bot 連携ステータスを確認する</li>
       </ol>`
    ),
  };
}

function mainEraTrialStarted(trialDays: number) {
  const days = escapeHtml(Number(trialDays));
  return {
    subject: sanitizeEmailSubject(`トライアル開始（${trialDays}日間）`),
    html: realResend.renderStubHtml(
      "トライアル開始",
      `<p>${days}日間、Business 相当の機能をお試しいただけます。</p>
       <p>AI社員の雇用・承認・監査・連携設定をご利用ください。</p>`
    ),
  };
}

function mainEraTrialEnding(orgName: string, daysLeft: number) {
  const org = escapeHtml(orgName);
  const days = escapeHtml(Number(daysLeft));
  return {
    subject: sanitizeEmailSubject(`トライアル終了まであと ${daysLeft} 日 — ${orgName}`),
    html: realResend.renderStubHtml(
      "トライアル終了のお知らせ",
      `<p>${org} 様のトライアルはあと <strong>${days} 日</strong> で終了します。</p>
       <p>継続する場合は「請求」から Stripe Checkout（カード / 銀行振込 customer_balance）へ進んでください。</p>`
    ),
  };
}

const FLAG = "WELCOME_MAIL_FIXED_SUBJECT_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  delete process.env[FLAG];
  delete process.env.MAIL_UNVERIFIED_FROM_ENABLED;
  delete process.env.EMAIL_FROM_UNVERIFIED;
  delete process.env.RESEND_API_KEY;
  sent.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const ORG = "株式会社テスト";
const RAW_URL = "https://evil.example/phish";
const BIDI = `表\u202E向き${ORG}`;
const DIRTY_ORG = `https://evil.example/phish\r\nBcc: x@evil.example\u202E${"x".repeat(400)}社`;

function mailOf(template: string): CapturedMail {
  const mail = sent.find((m) => m.template === template);
  expect(mail, `expected a ${template} send`).toBeTruthy();
  return mail!;
}

describe("send layer flag ON: actually-sent subjects are fixed", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("sendWelcomeEmail / sendTrialStartedEmail / sendTrialEndingEmail subjects", async () => {
    await sendWelcomeEmail("owner@example.invalid", ORG);
    await sendTrialStartedEmail("owner@example.invalid", 14);
    await sendTrialEndingEmail("owner@example.invalid", ORG, 3);
    expect(mailOf("welcome").subject).toBe(WELCOME_MAIL_FIXED_SUBJECT);
    expect(mailOf("welcome").subject).not.toContain(ORG);
    expect(mailOf("trial_started").subject).toBe(TRIAL_STARTED_FIXED_SUBJECT);
    expect(mailOf("trial_started").subject).not.toContain("14");
    expect(mailOf("trial_ending").subject).toBe(TRIAL_ENDING_FIXED_SUBJECT);
    expect(mailOf("trial_ending").subject).not.toContain(ORG);
    expect(mailOf("trial_ending").subject).not.toContain("3");
    expect(mailOf("welcome").html).toContain(ORG);
    expect(mailOf("trial_started").html).toContain("14日間");
    expect(mailOf("trial_ending").html).toContain(ORG);
  });

  test("raw URL is not <a href> or mailto on the wire", async () => {
    await sendWelcomeEmail("owner@example.invalid", RAW_URL);
    await sendTrialEndingEmail("owner@example.invalid", RAW_URL, 3);
    for (const template of ["welcome", "trial_ending"] as const) {
      const mail = mailOf(template);
      expect(mail.html).toContain("https://evil.example/phish");
      expect(mail.html).not.toContain("<a href");
      expect(mail.html).not.toContain("mailto:");
      expect(mail.subject).not.toContain("evil.example");
    }
  });

  test("trial_ending send strips bidi from the body", async () => {
    await sendTrialEndingEmail("owner@example.invalid", BIDI, 3);
    const mail = mailOf("trial_ending");
    expect(mail.subject).toBe(TRIAL_ENDING_FIXED_SUBJECT);
    expect(mail.subject).not.toContain("\u202E");
    expect(mail.html).not.toContain("\u202E");
    expect(mail.html).toContain("表向き");
  });
});

describe("orgs.create passes dirty orgName through to welcome", () => {
  test("source still calls sendWelcomeEmail(email, input.orgName)", () => {
    const src = readFileSync(join(process.cwd(), "lib/admin-mcp/orgs-create.ts"), "utf8");
    expect(src).toMatch(/sendWelcomeEmail\(\s*email,\s*input\.orgName\s*\)/);
  });

  test("flag ON: CRLF / bidi / overlong orgName → fixed subject, sanitized body", async () => {
    process.env[FLAG] = "true";
    await platformCreateOrg(
      {
        orgName: DIRTY_ORG,
        ownerEmail: "owner@example.invalid",
        integrationMode: "managed",
        trialDays: 14,
        invite: true,
        ownerPassword: "secure-pass-123456",
      },
      { email: "ops@example.com", userId: "ops_1", orgId: "org_ops" }
    );
    const welcome = mailOf("welcome");
    expect(welcome.subject).toBe(WELCOME_MAIL_FIXED_SUBJECT);
    expect(welcome.subject).not.toMatch(/[\r\n]/);
    expect(welcome.subject).not.toContain("\u202E");
    expect(welcome.subject).not.toContain("evil.example");
    expect(welcome.subject).not.toContain("Bcc");
    expect(welcome.html).not.toContain("\u202E");
    expect(welcome.html).not.toMatch(/[\r\n]Bcc/);
    expect(welcome.html).not.toContain("<a href");
    expect(welcome.html).not.toContain("mailto:");
    expect(welcome.html).not.toContain("x".repeat(400));
  });
});

describe("send layer flag OFF: subject and html match main-era output exactly", () => {
  test("welcome / trial_started / trial_ending", async () => {
    await sendWelcomeEmail("owner@example.invalid", ORG);
    await sendTrialStartedEmail("owner@example.invalid", 14);
    await sendTrialEndingEmail("owner@example.invalid", BIDI, 3);
    const welcomeExpected = mainEraWelcome(ORG);
    const trialExpected = mainEraTrialStarted(14);
    const endingExpected = mainEraTrialEnding(BIDI, 3);
    expect(mailOf("welcome").subject).toBe(welcomeExpected.subject);
    expect(mailOf("welcome").html).toBe(welcomeExpected.html);
    expect(mailOf("trial_started").subject).toBe(trialExpected.subject);
    expect(mailOf("trial_started").html).toBe(trialExpected.html);
    expect(mailOf("trial_ending").subject).toBe(endingExpected.subject);
    expect(mailOf("trial_ending").html).toBe(endingExpected.html);
    expect(mailOf("trial_ending").html).toContain("\u202E");
  });
});
