"use client";

import { useEffect, useState } from "react";
import type { Employee } from "@/lib/types";
import type { EmployeeGoogleIdentity } from "@/lib/data/google-identities";

const GOOGLE_QUERY_MESSAGES: Record<string, string> = {
  ok: "Google Calendar を連携しました",
  denied: "連携がキャンセルされました",
  admin_blocked:
    "Workspace のサードパーティアプリ制限によりブロックされました。" +
    "アカウントをオペレータが管理する Workspace または Staffpass を許可済みの Workspace に移すか、" +
    "管理者に Staffpass クライアントの許可を依頼してください（Admin console → Security → API controls → App access control）。",
  error: "Google Calendar 連携に失敗しました",
  scope_error: "許可されていないスコープが含まれています",
  forbidden: "連携の開始・解除には「雇う／社員証発行」の権限が必要です。オーナーまたは管理者に依頼してください。",
};

export function GoogleCalendarIdentityForm({
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
  /** Server decision (identityLinkPermissions): connect / disconnect allowed for this session. */
  canManage?: boolean;
}) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const linked = identity?.status === "linked" && Boolean(identity.googleSub);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google && GOOGLE_QUERY_MESSAGES[google]) {
      setMessage(GOOGLE_QUERY_MESSAGES[google]);
    }
  }, []);

  async function revoke() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/google/oauth/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId: employee.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "解除に失敗しました");
      setIdentity(null);
      setMessage("Google Calendar 連携を解除しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (!flagEnabled) {
    return (
      <div className="text-xs muted">
        Google Calendar 統合は現在無効です（GOOGLE_CALENDAR_READ_ENABLED=false）。
      </div>
    );
  }

  const locked = busy || disabled || !canManage;

  return (
    <div className="space-y-3">
      <p className="text-xs muted leading-relaxed">
        AI社員がカレンダーの空き時間（Free/Busy）を読み取れます。
        イベント内容は見えません。読み取れるカレンダーはアローリストで制限されます。
      </p>

      {linked ? (
        <p className="text-xs leading-relaxed">
          連携中: {identity?.googleEmail || identity?.googleSub}
          <span className="block text-[11px] muted mt-0.5">
            スコープ: {identity?.grantedScopes?.replace(/https:\/\/www\.googleapis\.com\/auth\//g, "")}
          </span>
        </p>
      ) : (
        <div className="text-xs muted leading-relaxed space-y-2">
          <p>
            <strong>接続するアカウント:</strong> AI 社員専用の Google アカウント（オペレータが管理する Workspace、または Staffpass を許可済みの Workspace）
          </p>
          <p>
            <strong>相手方への依頼:</strong> 相手方は Staffpass に接続せず、カレンダーを AI 社員アカウントに共有してください（空き時間のみで OK）。
          </p>
        </div>
      )}

      {oauthConfigured ? (
        <div className="flex flex-wrap gap-2">
          <a
            className="btn btn-primary text-xs"
            // No live href while locked: aria-disabled alone does not stop navigation.
            href={locked ? undefined : `/api/google/oauth/start?employeeId=${encodeURIComponent(employee.id)}`}
            aria-disabled={locked}
          >
            Google Calendar 連携
          </a>
          {linked ? (
            <button
              type="button"
              className="btn btn-ghost text-xs"
              disabled={locked}
              onClick={() => void revoke()}
            >
              連携を解除
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-[var(--warn)]">Google OAuth が未設定</p>
      )}

      {!canManage ? <p className="text-[11px] muted">連携の開始・解除は「雇う／社員証発行」の権限を持つメンバー（オーナー・管理者など）が行います。</p> : null}
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
