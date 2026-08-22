import {
  approvalNeededTemplate,
  trialEndingTemplate,
  trialStartedTemplate,
  welcomeTemplate,
} from "./email-templates";
import {
  renderStubHtml,
  sendTransactionalEmail,
  type EmailTemplate,
} from "./resend";

export async function sendWelcomeEmail(to: string, orgName: string) {
  const t = welcomeTemplate(orgName);
  return sendTransactionalEmail({
    to,
    template: "welcome",
    subject: t.subject,
    html: t.html,
    tags: [{ name: "template", value: "welcome" }],
  });
}

export async function sendTrialStartedEmail(to: string, trialDays: number) {
  const t = trialStartedTemplate(trialDays);
  return sendTransactionalEmail({
    to,
    template: "trial_started",
    subject: t.subject,
    html: t.html,
    tags: [{ name: "template", value: "trial_started" }],
  });
}

export async function sendTrialEndingEmail(
  to: string,
  orgName: string,
  daysLeft: number
) {
  const t = trialEndingTemplate(orgName, daysLeft);
  return sendTransactionalEmail({
    to,
    template: "trial_ending",
    subject: t.subject,
    html: t.html,
    tags: [{ name: "template", value: "trial_ending" }],
  });
}

export async function sendApprovalNeededEmail(
  to: string,
  summary: string,
  risk: string
) {
  const t = approvalNeededTemplate(summary, risk);
  return sendTransactionalEmail({
    to,
    template: "approval_needed",
    subject: t.subject,
    html: t.html,
    tags: [{ name: "template", value: "approval_needed" }],
  });
}

export async function sendApprovalNotification(
  to: string,
  kind: "approval_requested" | "approval_resolved" | "approval_needed",
  summary: string,
  risk = "medium"
) {
  if (kind === "approval_needed" || kind === "approval_requested") {
    return sendApprovalNeededEmail(to, summary, risk);
  }
  const template: EmailTemplate = "approval_resolved";
  return sendTransactionalEmail({
    to,
    template,
    subject: "[AI社員] 承認が解決されました",
    html: renderStubHtml("承認が解決されました", `<p>${summary}</p>`),
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
