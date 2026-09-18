import { NextResponse } from "next/server";
import { sendTransactionalEmail, renderStubHtml } from "@/lib/resend";

const NOTIFY_EMAIL = process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL || "tando@tokyo307inc.com";

const VALID_PLANS = ["intern", "proper", "executive", "custom", "undecided"] as const;
const VALID_BILLING = ["monthly", "annual"] as const;

interface InquiryPayload {
  plan?: string;
  company?: string;
  name?: string;
  email?: string;
  phone?: string;
  headcount?: string;
  useCase?: string;
  billingPreference?: string;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitize(str: string | undefined): string {
  if (!str) return "";
  return str.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function getPlanLabel(plan: string): string {
  switch (plan) {
    case "intern":
      return "インターン（¥50,000/月）";
    case "proper":
      return "プロパー（¥150,000/月）";
    case "executive":
      return "エグゼクティブ（¥300,000/月）";
    case "custom":
      return "カスタマイズ（個別見積）";
    case "undecided":
      return "未定";
    default:
      return plan;
  }
}

export async function POST(req: Request) {
  let body: InquiryPayload;
  try {
    body = (await req.json()) as InquiryPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { plan, company, name, email, phone, headcount, useCase, billingPreference } = body;

  if (!plan || !VALID_PLANS.includes(plan as (typeof VALID_PLANS)[number])) {
    return NextResponse.json(
      { ok: false, error: "invalid_plan", message: "プランを選択してください" },
      { status: 400 }
    );
  }

  if (!company || company.trim().length < 1) {
    return NextResponse.json(
      { ok: false, error: "invalid_company", message: "会社名を入力してください" },
      { status: 400 }
    );
  }

  if (!name || name.trim().length < 1) {
    return NextResponse.json(
      { ok: false, error: "invalid_name", message: "お名前を入力してください" },
      { status: 400 }
    );
  }

  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { ok: false, error: "invalid_email", message: "有効なメールアドレスを入力してください" },
      { status: 400 }
    );
  }

  if (!useCase || useCase.trim().length < 5) {
    return NextResponse.json(
      { ok: false, error: "invalid_use_case", message: "業務内容を入力してください" },
      { status: 400 }
    );
  }

  const billing =
    billingPreference && VALID_BILLING.includes(billingPreference as (typeof VALID_BILLING)[number])
      ? billingPreference
      : "monthly";

  const timestamp = new Date().toISOString();

  const htmlBody = `
    <h2>AI社員パック お問い合わせ</h2>
    <p><strong>受付日時:</strong> ${timestamp}</p>
    <hr />
    <table style="border-collapse:collapse;width:100%;">
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;width:120px;"><strong>プラン</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(getPlanLabel(plan))}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>会社名</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(company)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>お名前</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(name)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>メール</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;"><a href="mailto:${sanitize(email)}">${sanitize(email)}</a></td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>電話</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(phone || "未入力")}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>導入予定人数</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(headcount || "未入力")}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>請求希望</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${billing === "annual" ? "年払い（10%オフ）" : "月払い"}</td></tr>
    </table>
    <h3 style="margin-top:16px;">AI社員に任せたい業務</h3>
    <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-radius:8px;">${sanitize(useCase)}</p>
    <hr />
    <p style="font-size:12px;color:#666;">このメールは /lp/ai-employee/consult から自動送信されました。</p>
  `;

  const result = await sendTransactionalEmail({
    to: NOTIFY_EMAIL,
    template: "approval_needed",
    subject: `【AI社員パック問い合わせ】${company} - ${name}様`,
    html: renderStubHtml("AI社員パック お問い合わせ", htmlBody),
  });

  if (!result.ok) {
    console.error("[ai-employee-inquiry] Failed to send email:", result.error);
    return NextResponse.json(
      {
        ok: false,
        error: "email_failed",
        message: "送信に失敗しました。しばらくしてからお試しください。",
      },
      { status: 500 }
    );
  }

  console.info("[ai-employee-inquiry] Inquiry received:", {
    plan,
    company,
    name,
    email: email.substring(0, 3) + "***",
    billing,
    stub: result.stub,
  });

  return NextResponse.json({
    ok: true,
    message: "お問い合わせを受け付けました",
    stub: result.stub,
  });
}
