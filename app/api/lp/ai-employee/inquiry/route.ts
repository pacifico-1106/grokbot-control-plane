import { NextResponse } from "next/server";
import { sendTransactionalEmail, renderStubHtml } from "@/lib/resend";
import { 
  isLpInquiryDbEnabled, 
  isLpInquiryBotProtectionEnabled 
} from "@/lib/feature-flags";
import { createInquiry, type InquiryPlan, type BillingPreference } from "@/lib/lp/inquiry-data";
import { enqueueNotification, processOutboxEntry } from "@/lib/lp/notification-outbox";
import { verifyTurnstileToken, getClientIp, getTurnstileConfig } from "@/lib/lp/turnstile";
import { hashIp, checkRateLimits } from "@/lib/lp/rate-limit";

const NOTIFY_EMAIL = process.env.AI_EMP_INQUIRY_NOTIFY_EMAIL;

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
  turnstileToken?: string;
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
  const clientIp = getClientIp(req);
  const botProtectionEnabled = isLpInquiryBotProtectionEnabled();
  
  if (botProtectionEnabled && clientIp) {
    const ipHash = hashIp(clientIp);
    const rateLimitResult = checkRateLimits(ipHash);
    
    if (!rateLimitResult.allowed) {
      console.warn("[ai-employee-inquiry] Rate limit exceeded:", { ipHash: ipHash.slice(0, 8) });
      return NextResponse.json(
        { 
          ok: false, 
          error: "rate_limited", 
          message: "リクエストが多すぎます。しばらくしてからお試しください。" 
        },
        { 
          status: 429,
          headers: {
            "Retry-After": String(rateLimitResult.retryAfterSeconds || 60),
          },
        }
      );
    }
  }

  let body: InquiryPayload;
  try {
    body = (await req.json()) as InquiryPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { plan, company, name, email, phone, headcount, useCase, billingPreference, turnstileToken } = body;

  if (botProtectionEnabled) {
    const turnstileConfig = getTurnstileConfig();
    
    if (turnstileConfig) {
      if (!turnstileToken) {
        return NextResponse.json(
          { ok: false, error: "turnstile_required", message: "認証が必要です" },
          { status: 400 }
        );
      }
      
      const turnstileResult = await verifyTurnstileToken(turnstileToken, clientIp);
      
      if (!turnstileResult.success) {
        console.warn("[ai-employee-inquiry] Turnstile verification failed:", turnstileResult.errorCodes);
        return NextResponse.json(
          { ok: false, error: "turnstile_failed", message: "認証に失敗しました。もう一度お試しください。" },
          { status: 400 }
        );
      }
    } else {
      console.warn("[ai-employee-inquiry] Bot protection enabled but Turnstile not configured, proceeding unprotected");
    }
  }

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

  if (useCase.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "use_case_too_long", message: "業務内容は2000文字以内で入力してください" },
      { status: 400 }
    );
  }

  const billing =
    billingPreference && VALID_BILLING.includes(billingPreference as (typeof VALID_BILLING)[number])
      ? billingPreference
      : "monthly";

  const timestamp = new Date().toISOString();
  const dbEnabled = isLpInquiryDbEnabled();

  let inquiryId: string | null = null;

  if (dbEnabled) {
    try {
      const inquiry = await createInquiry({
        source: "form",
        plan: plan as InquiryPlan,
        billingPreference: billing as BillingPreference,
        company: company.trim(),
        contactName: name.trim(),
        email: email.trim(),
        phone: phone?.trim(),
        headcount: headcount?.trim(),
        useCase: useCase.trim(),
        consentGiven: true,
        consentVersion: "lp-v1",
      });

      if (inquiry) {
        inquiryId = inquiry.id;
        console.info("[ai-employee-inquiry] Inquiry saved to DB:", { inquiryId });
      }
    } catch (error) {
      console.error("[ai-employee-inquiry] Failed to save inquiry to DB:", error);
    }
  }

  if (!NOTIFY_EMAIL) {
    console.error("[ai-employee-inquiry] AI_EMP_INQUIRY_NOTIFY_EMAIL not configured, notification not sent");
    
    if (dbEnabled && inquiryId) {
      return NextResponse.json({
        ok: true,
        message: "お問い合わせを受け付けました",
        inquiryId,
        notificationSent: false,
      });
    }
    
    return NextResponse.json(
      { ok: false, error: "config_error", message: "設定エラーが発生しました。管理者にお問い合わせください。" },
      { status: 500 }
    );
  }

  const htmlBody = `
    <h2>AI社員パック お問い合わせ</h2>
    <p><strong>受付日時:</strong> ${timestamp}</p>
    ${inquiryId ? `<p><strong>問い合わせID:</strong> ${inquiryId}</p>` : ""}
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

  const subject = `【AI社員パック問い合わせ】${company} - ${name}様`;

  if (dbEnabled && inquiryId) {
    try {
      const businessKey = `inquiry:${inquiryId}`;
      const outboxEntry = await enqueueNotification({
        businessKey,
        notificationType: "inquiry_received",
        recipient: NOTIFY_EMAIL,
        subject,
        template: "approval_needed",
        payload: {
          inquiryId,
          timestamp,
          plan,
          company,
          contactName: name,
          email,
          phone: phone || null,
          headcount: headcount || null,
          billingPreference: billing,
          useCase,
        },
      });

      if (outboxEntry) {
        const sent = await processOutboxEntry(outboxEntry.id);
        
        console.info("[ai-employee-inquiry] Inquiry processed via outbox:", {
          inquiryId,
          outboxId: outboxEntry.id,
          sent,
        });

        return NextResponse.json({
          ok: true,
          message: "お問い合わせを受け付けました",
          inquiryId,
        });
      }
    } catch (error) {
      console.error("[ai-employee-inquiry] Outbox processing failed:", error);
    }
  }

  const result = await sendTransactionalEmail({
    to: NOTIFY_EMAIL,
    template: "approval_needed",
    subject,
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
    inquiryId,
  });

  return NextResponse.json({
    ok: true,
    message: "お問い合わせを受け付けました",
    stub: result.stub,
    inquiryId,
  });
}
