"use client";

import { useEffect, useState } from "react";
import type { Employee, EmployeeSlackIdentity, PostingAs } from "@/lib/types";
import { policyErrorMessage } from "@/lib/employees/policy-errors";

const SLACK_QUERY_MESSAGES: Record<string, string> = {
  ok: "Slack 連携しました",
  mismatch: "この社員の Slack ID と一致しません",
  denied: "連携がキャンセルされました",
  error: "Slack 連携に失敗しました",
};

export function SlackIdentityForm({
  employee,
  initialIdentity,
  oauthConfigured,
  disabled = false,
}: {
  employee: Employee;
  initialIdentity: EmployeeSlackIdentity | null;
  oauthConfigured: boolean;
  disabled?: boolean;
}) {
  const [postingAs, setPostingAs] = useState<PostingAs>(employee.postingAs || "bot");
  const [identity, setIdentity] = useState(initialIdentity);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const linked = identity?.status === "linked" && Boolean(identity.slackUserId);
  const userOptionDimmed = postingAs === "user" && !linked;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slack = params.get("slack");
    if (slack && SLACK_QUERY_MESSAGES[slack]) {
      setMessage(SLACK_QUERY_MESSAGES[slack]);
    }
  }, []);

  async function savePostingAs(next: PostingAs) {
    setPostingAs(next);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/employees/${employee.id}/slack-identity`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingAs: next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(policyErrorMessage(body));
      if (body.employee?.postingAs === "user" || body.employee?.postingAs === "bot") {
        setPostingAs(body.employee.postingAs);
      }
      if (body.identity) setIdentity(body.identity);
      setMessage("投稿名義を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/employees/${employee.id}/slack-identity`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(policyErrorMessage(body, "解除に失敗しました"));
      setIdentity(null);
      setMessage("Slack 連携を解除しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || disabled;

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Slack 投稿名義</legend>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name={`posting-as-${employee.id}`}
            className="mt-1"
            checked={postingAs === "bot"}
            disabled={locked}
            onChange={() => void savePostingAs("bot")}
          />
          <span>
            <span className="font-medium">会社のBotとして出す</span>
            <span className="block text-xs muted mt-0.5">
              設定 → 「チャンネルに書き込む」の Bot token（xoxb）を使います。
            </span>
          </span>
        </label>
        <label
          className={`flex items-start gap-2 text-sm cursor-pointer ${userOptionDimmed ? "opacity-60" : ""}`}
        >
          <input
            type="radio"
            name={`posting-as-${employee.id}`}
            className="mt-1"
            checked={postingAs === "user"}
            disabled={locked}
            onChange={() => void savePostingAs("user")}
          />
          <span>
            <span className="font-medium">この人として出す</span>
            <span className="block text-xs muted mt-0.5">
              {linked
                ? "Staffpass Slack アプリの本人トークンで投稿します。"
                : "未連携でも選べます。Gateway は本人としては出せません。"}
            </span>
          </span>
        </label>
      </fieldset>

      <details className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Bot と 個人 の違い</summary>
        <div className="mt-3 grid sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
            <p className="font-medium mb-2">Bot（推奨: アプリDM向け）</p>
            <p className="text-[var(--ok)] mb-1">✓ 会社の窓口として一貫</p>
            <p className="text-[var(--ok)] mb-1">✓ アプリDM口と相性が良い</p>
            <p className="text-[var(--ok)] mb-1">✓ 人のSlack退席に依存しにくい</p>
            <p className="muted mt-2">△ 個人っぽさは出ない</p>
            <p className="muted">△ チャンネルで「人」として見せたいときは弱い</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
            <p className="font-medium mb-2">個人（推奨: チャネル・Connect・人対人DM向け）</p>
            <p className="text-[var(--ok)] mb-1">✓ 社員名義で信頼・責任が明確</p>
            <p className="text-[var(--ok)] mb-1">✓ 既存DM/チャンネルの人対人運用と一致</p>
            <p className="muted mt-2">△ 本人OAuth・トークン寿命・退席に依存</p>
            <p className="muted">△ アプリDMではBotトークンでないと投稿できない制約あり</p>
          </div>
        </div>
        <p className="mt-3 text-[11px] muted leading-relaxed">
          推奨デフォルト: アプリDM向け社員は <strong>bot</strong> / チャネル・Connect・人対人DM向けは <strong>user</strong>。
        </p>
      </details>

      {linked ? (
        <p className="text-xs leading-relaxed">
          連携中: {identity?.displayName ? `${identity.displayName} · ` : ""}
          <span className="font-mono">{identity?.slackUserId}</span>
        </p>
      ) : (
        <p className="text-xs muted leading-relaxed">
          許可アカウントに Slack ID（U…）を登録したうえで連携します。ユーザー token の貼り付けはできません。
        </p>
      )}

      {oauthConfigured ? (
        <div className="flex flex-wrap gap-2">
          <a
            className="btn btn-primary text-xs"
            href={`/api/slack/oauth/start?employeeId=${encodeURIComponent(employee.id)}`}
            aria-disabled={locked}
          >
            Slack 連携（Authorize）
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
        <p className="text-xs text-[var(--warn)]">Slack アプリの OAuth が未設定</p>
      )}

      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
