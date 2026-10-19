/**
 * LP consult-form notify mail (subject + HTML body).
 * LP_INQUIRY_FIXED_SUBJECT_ENABLED (default OFF) keeps today's subject
 * (`【AI社員パック問い合わせ】{会社} - {名前}様`) and mailto body.
 * When ON: fixed subject + receipt id; user input only in escaped cells.
 */
import { escapeHtml } from "@/lib/html-escape";
import { isLpInquiryFixedSubjectEnabled } from "@/lib/feature-flags";

export const LP_INQUIRY_SUBJECT_PREFIX = "【AI社員パック問い合わせ】";
export const LP_INQUIRY_FIELD_MAX = 200;
export const LP_INQUIRY_USE_CASE_MAX = 2000;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Same range as lib/approvals/attachment-card.ts (bidi / zero-width / BOM).
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function sanitizeInquiryPlainText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);
}

export function allocateInquiryReceiptId(inquiryId: string | null | undefined): string {
  const raw = String(inquiryId ?? "").trim();
  if (/^[A-Za-z0-9_-]{1,40}$/.test(raw)) return raw;
  return `R${Date.now().toString(36).toUpperCase()}`;
}

export type InquiryNotifyInput = {
  timestamp: string;
  inquiryId: string | null;
  planLabel: string;
  company: string;
  name: string;
  email: string;
  phone: string;
  headcount: string;
  billingLabel: string;
  lpPageLabel: string;
  lpRef: string | null;
  useCase: string;
};

function row(label: string, value: string): string {
  return `<tr><td style="padding:8px 4px;border-bottom:1px solid #eee;${
    label === "プラン" ? "width:120px;" : ""
  }"><strong>${escapeHtml(label)}</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${escapeHtml(value)}</td></tr>`;
}

export function buildInquiryNotify(input: InquiryNotifyInput): { subject: string; html: string } {
  const receiptId = allocateInquiryReceiptId(input.inquiryId);
  if (!isLpInquiryFixedSubjectEnabled()) {
    return {
      subject: `${LP_INQUIRY_SUBJECT_PREFIX}${input.company} - ${input.name}様`,
      html: "",
    };
  }

  const company = sanitizeInquiryPlainText(input.company, LP_INQUIRY_FIELD_MAX);
  const name = sanitizeInquiryPlainText(input.name, LP_INQUIRY_FIELD_MAX);
  const email = sanitizeInquiryPlainText(input.email, LP_INQUIRY_FIELD_MAX);
  const phone = sanitizeInquiryPlainText(input.phone || "未入力", LP_INQUIRY_FIELD_MAX);
  const headcount = sanitizeInquiryPlainText(input.headcount || "未入力", LP_INQUIRY_FIELD_MAX);
  const useCase = sanitizeInquiryPlainText(input.useCase, LP_INQUIRY_USE_CASE_MAX);
  const planLabel = sanitizeInquiryPlainText(input.planLabel, LP_INQUIRY_FIELD_MAX);
  const billingLabel = sanitizeInquiryPlainText(input.billingLabel, LP_INQUIRY_FIELD_MAX);
  const lpPage = sanitizeInquiryPlainText(input.lpPageLabel, LP_INQUIRY_FIELD_MAX);
  const lpRef = input.lpRef
    ? sanitizeInquiryPlainText(input.lpRef, LP_INQUIRY_FIELD_MAX)
    : "";
  const timestamp = sanitizeInquiryPlainText(input.timestamp, LP_INQUIRY_FIELD_MAX);

  const html = `
    <h2>AI社員パック お問い合わせ</h2>
    <p><strong>受付日時:</strong> ${escapeHtml(timestamp)}</p>
    <p><strong>受付番号:</strong> ${escapeHtml(receiptId)}</p>
    <hr />
    <table style="border-collapse:collapse;width:100%;">
      ${row("プラン", planLabel)}
      ${row("会社名", company)}
      ${row("お名前", name)}
      ${row("メール", email)}
      ${row("電話", phone)}
      ${row("導入予定人数", headcount)}
      ${row("請求希望", billingLabel)}
      ${row("流入ページ", lpPage)}
      ${lpRef ? row("紹介元(ref)", lpRef) : ""}
    </table>
    <h3 style="margin-top:16px;">AI社員に任せたい業務</h3>
    <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-radius:8px;">${escapeHtml(useCase)}</p>
    <hr />
    <p style="font-size:12px;color:#666;">このメールは LP の相談フォームから送信（流入ページは下記）されました。</p>
  `;

  return {
    subject: `${LP_INQUIRY_SUBJECT_PREFIX}${receiptId}`,
    html,
  };
}
