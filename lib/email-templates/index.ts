import { renderStubHtml } from "@/lib/resend";

function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ||
    "https://staffpass.sealith.com"
  );
}

function dashboardCta(label: string): string {
  const href = `${appBaseUrl()}/app/approvals`;
  return `<p style="margin:24px 0 8px"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">${label}</a></p>`;
}

function statusLabelJa(statusLabel: string): string {
  if (statusLabel === "approved" || statusLabel === "承認済み") return "承認済み";
  if (statusLabel === "rejected" || statusLabel === "却下") return "却下";
  if (
    statusLabel === "revision_requested" ||
    statusLabel === "修正依頼"
  )
    return "修正依頼";
  return statusLabel;
}

export function welcomeTemplate(orgName: string) {
  return {
    subject: `ようこそ — ${orgName} の AI社員 制御面`,
    html: renderStubHtml(
      "ようこそ",
      `<p>${orgName} 様の制御面を準備しました。</p>
       <p>次のステップ:</p>
       <ol>
         <li>はじめに チェックリストを開く</li>
         <li>最初の AI社員を雇う（職務を日本語で説明 → Draft → 社員証発行）</li>
         <li>Grok Bot 連携ステータスを確認する</li>
       </ol>`
    ),
  };
}

export function approvalNeededTemplate(summary: string, risk: string) {
  return {
    subject: `[要対応] AI社員の承認リクエスト（${risk}）`,
    html: renderStubHtml(
      "承認が必要です",
      `<p>危険操作またはポリシー該当の操作が承認待ちです。</p>
       <p><strong>${summary}</strong></p>
       <p>リスク: ${risk}</p>
       <p>制御面の「承認」から許可または却下してください。</p>
       ${dashboardCta("ダッシュボードで承認する")}`
    ),
  };
}

export function approvalResolvedTemplate(summary: string, statusLabel: string) {
  const statusJa = statusLabelJa(statusLabel);
  return {
    subject: `[AI社員] 承認が解決されました（${statusJa}）`,
    html: renderStubHtml(
      "承認が解決されました",
      `<p>承認リクエストが処理されました。</p>
       <p>結果: <strong>${statusJa}</strong></p>
       <p>${summary}</p>
       ${dashboardCta("ダッシュボードを開く")}`
    ),
  };
}

export function trialEndingTemplate(orgName: string, daysLeft: number) {
  return {
    subject: `トライアル終了まであと ${daysLeft} 日 — ${orgName}`,
    html: renderStubHtml(
      "トライアル終了のお知らせ",
      `<p>${orgName} 様のトライアルはあと <strong>${daysLeft} 日</strong> で終了します。</p>
       <p>継続する場合は「請求」から Stripe Checkout（カード / 銀行振込 customer_balance）へ進んでください。</p>`
    ),
  };
}

export function trialStartedTemplate(trialDays: number) {
  return {
    subject: `トライアル開始（${trialDays}日間）`,
    html: renderStubHtml(
      "トライアル開始",
      `<p>${trialDays}日間、Business 相当の機能をお試しいただけます。</p>
       <p>AI社員の雇用・承認・監査・連携設定をご利用ください。</p>`
    ),
  };
}
