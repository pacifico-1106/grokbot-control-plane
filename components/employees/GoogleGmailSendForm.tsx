"use client";

import { useEffect, useState } from "react";
import type { Employee } from "@/lib/types";
import type { EmployeeGoogleIdentity } from "@/lib/data/google-identities";

const GOOGLE_QUERY_MESSAGES: Record<string, string> = {
  gmail_ok: "Gmail 送信（mail.send）を連携しました",
  ok: "Google アカウントを連携しました",
  denied: "連携がキャンセルされました",
  admin_blocked:
    "Workspace のサードパーティアプリ制限によりブロックされました。" +
    "管理者に Staffpass クライアントの許可を依頼してください。",
  error: "Gmail 送信の連携に失敗しました",
  scope_error: "許可されていないスコープが含まれています",
  account_mismatch: "既に別の Google アカウントが連携されています。解除してからやり直してください。",
  forbidden: "連携の開始・解除には「雇う／社員証発行」の権限が必要です。オーナーまたは管理者に依頼してください。",
};

export function GoogleGmailSendForm({
  employee,
  initialIdentity,
  oauthConfigured,
  flagEnabled,
  disabled = false,
  canManage = true,
}: {
  employee: Employee;
  initialIdentity: EmployeeGoogleIdentity | null;
  oauthConfigured: boolean;
  flagEnabled: boolean;
  disabled?: boolean;
  canManage?: boolean;
}) {
  const [identity] = useState(initialIdentity);
  const [message, setMessage] = useState("");

  const linked = identity?.status === "linked" && Boolean(identity.googleSub);
  const hasGmailSend = Boolean(identity?.grantedScopes?.includes("gmail.send"));
  const startHref = `/api/google/oauth/start?employeeId=${encodeURIComponent(employee.id)}&intent=gmail.send`;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google && GOOGLE_QUERY_MESSAGES[google]) {
      setMessage(GOOGLE_QUERY_MESSAGES[google]);
    }
  }, []);

  if (!flagEnabled) {
    return (
      <div className="text-xs muted">
        Gmail ライブ送信は現在無効です（MAIL_SEND_GMAIL_LIVE=false）。
      </div>
    );
  }

  const locked = disabled || !canManage;

  return (
    <div className="space-y-3">
      <p className="text-xs muted leading-relaxed">
        承認済みの mail.send を、連携したメールボックスから Gmail API で送ります。
        カレンダー連携とは別の同意です。From はそのメールアドレスと一致している必要があります。
      </p>

      {linked ? (
        <p className="text-xs leading-relaxed">
          連携中: {identity?.googleEmail || identity?.googleSub}
          <span className="block text-[11px] muted mt-0.5">
            gmail.send: {hasGmailSend ? "許可済み" : "未許可（下のボタンで追加同意）"}
          </span>
        </p>
      ) : (
        <p className="text-xs muted leading-relaxed">
          送信に使う Google アカウント（例: tando@tokyo307inc.com）で追加同意します。
        </p>
      )}

      {oauthConfigured ? (
        <div className="flex flex-wrap gap-2">
          <a
            className="btn btn-primary text-xs"
            href={locked ? undefined : startHref}
            aria-disabled={locked}
          >
            Gmail 送信を許可
          </a>
        </div>
      ) : (
        <p className="text-xs text-[var(--warn)]">Google OAuth が未設定</p>
      )}

      {!canManage ? (
        <p className="text-[11px] muted">
          連携の開始は「雇う／社員証発行」の権限を持つメンバーが行います。
        </p>
      ) : null}
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
