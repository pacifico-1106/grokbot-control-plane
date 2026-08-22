import {
  renderStubHtml,
  sendTransactionalEmail,
  type EmailTemplate,
} from "./resend";

/** High-level helpers used by API routes / stubs */

export async function sendWelcomeEmail(to: string, orgName: string) {
  return sendTransactionalEmail({
    to,
    template: "welcome",
    subject: `ようこそ — ${orgName} の AI社員 制御面`,
    html: renderStubHtml(
      "ようこそ",
      `<p>${orgName} 様の制御面を準備しました。</p><p>社員証・承認・監査から始められます。</p>`
    ),
    tags: [{ name: "template", value: "welcome" }],
  });
}

export async function sendTrialStartedEmail(to: string, trialDays: number) {
  return sendTransactionalEmail({
    to,
    template: "trial_started",
    subject: `トライアル開始（${trialDays}日間）`,
    html: renderStubHtml(
      "トライアル開始",
      `<p>${trialDays}日間、Business 相当の機能をお試しいただけます。</p>`
    ),
    tags: [{ name: "template", value: "trial_started" }],
  });
}

export async function sendApprovalNotification(
  to: string,
  kind: "approval_requested" | "approval_resolved",
  summary: string
) {
  const template: EmailTemplate = kind;
  const title =
    kind === "approval_requested" ? "承認リクエスト" : "承認が解決されました";
  return sendTransactionalEmail({
    to,
    template,
    subject: `[AI社員] ${title}`,
    html: renderStubHtml(title, `<p>${summary}</p>`),
    tags: [{ name: "template", value: kind }],
  });
}

export async function sendBillingEmail(to: string, subject: string, body: string) {
  return sendTransactionalEmail({
    to,
    template: "billing_receipt",
    subject,
    html: renderStubHtml("お支払いのお知らせ", body),
    tags: [{ name: "template", value: "billing_receipt" }],
  });
}
