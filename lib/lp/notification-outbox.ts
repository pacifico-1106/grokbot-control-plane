/**
 * Notification outbox for LP events.
 * Ensures durable, idempotent notification delivery.
 */

import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpInquiryDbEnabled, isLpInquiryFixedSubjectEnabled } from "@/lib/feature-flags";
import { sendTransactionalEmail, renderStubHtml } from "@/lib/resend";
import { lpPageLabel, parseLpPage, parseLpRef } from "@/lib/lp/lp-page";
import { buildInquiryNotify } from "@/lib/lp/inquiry-mail";

export type NotificationType = 
  | "inquiry_received" 
  | "handoff_created" 
  | "order_submitted" 
  | "payment_confirmed";

export type OutboxStatus = "pending" | "sent" | "failed" | "skipped";

export interface OutboxEntry {
  id: string;
  tenantId: string;
  businessKey: string;
  notificationType: NotificationType;
  recipient: string;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  providerId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  processedAt: string | null;
}

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

function mapRow(row: Record<string, unknown>): OutboxEntry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    businessKey: String(row.business_key),
    notificationType: row.notification_type as NotificationType,
    recipient: String(row.recipient),
    subject: String(row.subject),
    template: String(row.template),
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: (row.status as OutboxStatus) ?? "pending",
    providerId: row.provider_id ? String(row.provider_id) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    processedAt: row.processed_at ? String(row.processed_at) : null,
  };
}

export async function enqueueNotification(params: {
  businessKey: string;
  notificationType: NotificationType;
  recipient: string;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
}): Promise<OutboxEntry | null> {
  if (!isLpInquiryDbEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[notification-outbox] Supabase admin client not configured");
    return null;
  }

  const { data: existing } = await admin
    .from("notification_outbox")
    .select("*")
    .eq("tenant_id", DEFAULT_TENANT_ID)
    .eq("business_key", params.businessKey)
    .maybeSingle();

  if (existing) {
    return mapRow(existing as Record<string, unknown>);
  }

  const { data, error } = await admin
    .from("notification_outbox")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      business_key: params.businessKey,
      notification_type: params.notificationType,
      recipient: params.recipient,
      subject: params.subject,
      template: params.template,
      payload: params.payload,
      status: "pending",
      attempt_count: 0,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: duplicate } = await admin
        .from("notification_outbox")
        .select("*")
        .eq("tenant_id", DEFAULT_TENANT_ID)
        .eq("business_key", params.businessKey)
        .single();
      if (duplicate) {
        return mapRow(duplicate as Record<string, unknown>);
      }
    }
    console.error("[notification-outbox] Failed to enqueue:", error);
    throw new Error(error.message || "enqueue_failed");
  }

  return mapRow(data as Record<string, unknown>);
}

export async function processOutboxEntry(entryId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { data: entry, error: fetchError } = await admin
    .from("notification_outbox")
    .select("*")
    .eq("id", entryId)
    .single();

  if (fetchError || !entry) {
    console.error("[notification-outbox] Entry not found:", entryId);
    return false;
  }

  const outboxEntry = mapRow(entry as Record<string, unknown>);
  
  if (outboxEntry.status === "sent") {
    return true;
  }

  const now = new Date().toISOString();

  await admin
    .from("notification_outbox")
    .update({
      attempt_count: outboxEntry.attemptCount + 1,
      last_attempt_at: now,
    })
    .eq("id", entryId);

  try {
    const htmlBody = renderNotificationHtml(outboxEntry);
    
    const result = await sendTransactionalEmail({
      to: outboxEntry.recipient,
      template: "approval_needed",
      subject: outboxEntry.subject,
      html: renderStubHtml(outboxEntry.subject, htmlBody),
    });

    if (!result.ok) {
      await admin
        .from("notification_outbox")
        .update({
          status: "failed",
          last_error: result.error || "send_failed",
        })
        .eq("id", entryId);
      return false;
    }

    await admin
      .from("notification_outbox")
      .update({
        status: "sent",
        provider_id: result.id || null,
        processed_at: now,
        last_error: null,
      })
      .eq("id", entryId);

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown_error";
    await admin
      .from("notification_outbox")
      .update({
        status: "failed",
        last_error: errorMessage,
      })
      .eq("id", entryId);
    return false;
  }
}

/**
 * 流入ページ / 紹介元(ref) rows from the stored payload, re-checked against the allowlist and
 * the ref pattern (never echoes a tampered value). Empty for entries written before lpPage
 * existed, so their emails render exactly as before.
 */
function leadRows(payload: Record<string, unknown>): string {
  const page = parseLpPage(payload.lpPage);
  if (!page) return "";
  const ref = parseLpRef(payload.lpRef);
  const row = (label: string, value: string) =>
    `<tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>${label}</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(value)}</td></tr>`;
  return row("流入ページ", lpPageLabel(page)) + (ref ? row("紹介元(ref)", ref) : "");
}

export function renderNotificationHtml(entry: OutboxEntry): string {
  const payload = entry.payload;
  
  switch (entry.notificationType) {
    case "inquiry_received":
      return renderInquiryHtml(payload);
    case "handoff_created":
      return renderHandoffHtml(payload);
    default:
      return `<p>通知タイプ: ${sanitize(entry.notificationType)}</p>`;
  }
}

function sanitize(str: string | undefined): string {
  if (!str) return "";
  return str.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function getPlanLabel(plan: string): string {
  switch (plan) {
    case "intern": return "インターン（¥50,000/月）";
    case "proper": return "プロパー（¥150,000/月）";
    case "executive": return "エグゼクティブ（¥300,000/月）";
    case "custom": return "カスタマイズ（個別見積）";
    case "undecided": return "未定";
    default: return plan;
  }
}

function renderInquiryHtml(payload: Record<string, unknown>): string {
  const timestamp = String(payload.timestamp || new Date().toISOString());
  const plan = String(payload.plan || "undecided");
  const company = String(payload.company || "");
  const name = String(payload.contactName || "");
  const email = String(payload.email || "");
  const phone = String(payload.phone || "未入力");
  const headcount = String(payload.headcount || "未入力");
  const billing = payload.billingPreference === "annual" ? "年払い（10%オフ）" : "月払い";
  const useCase = String(payload.useCase || "");
  const inquiryId = String(payload.inquiryId || "");

  if (isLpInquiryFixedSubjectEnabled()) {
    return buildInquiryNotify({
      timestamp,
      inquiryId: inquiryId || null,
      planLabel: getPlanLabel(plan),
      company,
      name,
      email,
      phone,
      headcount,
      billingLabel: billing,
      lpPageLabel: (() => {
        const page = parseLpPage(payload.lpPage);
        return page ? lpPageLabel(page) : "";
      })(),
      lpRef: parseLpRef(payload.lpRef),
      useCase,
    }).html;
  }

  return `
    <h2>AI社員パック お問い合わせ</h2>
    <p><strong>受付日時:</strong> ${sanitize(timestamp)}</p>
    ${inquiryId ? `<p><strong>問い合わせID:</strong> ${sanitize(inquiryId)}</p>` : ""}
    <hr />
    <table style="border-collapse:collapse;width:100%;">
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;width:120px;"><strong>プラン</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(getPlanLabel(plan))}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>会社名</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(company)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>お名前</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(name)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>メール</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;"><a href="mailto:${sanitize(email)}">${sanitize(email)}</a></td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>電話</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(phone)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>導入予定人数</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(headcount)}</td></tr>
      <tr><td style="padding:8px 4px;border-bottom:1px solid #eee;"><strong>請求希望</strong></td><td style="padding:8px 4px;border-bottom:1px solid #eee;">${sanitize(billing)}</td></tr>
      ${leadRows(payload)}
    </table>
    <h3 style="margin-top:16px;">AI社員に任せたい業務</h3>
    <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-radius:8px;">${sanitize(useCase)}</p>
    <hr />
    ${
      leadRows(payload)
        ? '<p style="font-size:12px;color:#666;">このメールは LP の相談フォームから送信（流入ページは下記）されました。</p>'
        : '<p style="font-size:12px;color:#666;">このメールは /lp/ai-employee/consult から自動送信されました。</p>'
    }
  `;
}

function renderHandoffHtml(payload: Record<string, unknown>): string {
  const timestamp = String(payload.timestamp || new Date().toISOString());
  const summary = String(payload.summary || "");
  const journeyId = String(payload.journeyId || "");

  return `
    <h2>AI社員パック 相談引継ぎ</h2>
    <p><strong>受付日時:</strong> ${sanitize(timestamp)}</p>
    ${journeyId ? `<p><strong>会話ID:</strong> ${sanitize(journeyId)}</p>` : ""}
    ${leadRows(payload) ? `<table style="border-collapse:collapse;width:100%;">${leadRows(payload)}</table>` : ""}
    <hr />
    <h3>相談要約</h3>
    <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-radius:8px;">${sanitize(summary)}</p>
    <hr />
    <p style="font-size:12px;color:#666;">このメールはAI相談窓口から自動送信されました。</p>
  `;
}

export async function getPendingOutboxEntries(limit: number = 10): Promise<OutboxEntry[]> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return [];
  }

  const { data, error } = await admin
    .from("notification_outbox")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.map((row) => mapRow(row as Record<string, unknown>));
}
