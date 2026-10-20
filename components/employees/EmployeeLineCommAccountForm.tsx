"use client";

import { useState } from "react";

type Account = {
  id: string;
  status: string;
  botUserId: string;
  displayName: string | null;
  webhookPath: string;
  webhookUrl: string | null;
};

export function EmployeeLineCommAccountForm({
  employeeId,
  canConnect,
  initialAccount,
  disabled,
}: {
  employeeId: string;
  canConnect: boolean;
  initialAccount: Account | null;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<Account | null>(initialAccount);
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [okMessage, setOkMessage] = useState("");

  if (!canConnect) return null;

  async function submit(withSecrets: boolean) {
    setBusy(true);
    setMessage("");
    setOkMessage("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/comm-account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withSecrets ? { channelAccessToken: token, channelSecret: secret } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        webhookUrl?: string;
        account?: Account;
      };
      if (body.account) setAccount(body.account);
      if (!res.ok || !body.ok) throw new Error(body.message || body.error || "接続に失敗しました");
      setToken("");
      setSecret("");
      setOkMessage(body.webhookUrl ? `Webhook を登録しました: ${body.webhookUrl}` : "Webhook を登録しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "接続に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs muted leading-relaxed">
        この社員専用の LINE 公式アカウントを接続します。チャネルアクセストークンはサーバーだけが復号し、ログには残りません。AI は実行できません。
      </p>
      {account ? (
        <dl className="text-sm space-y-2">
          <div>
            <dt className="text-xs muted">ボット userId</dt>
            <dd className="mt-1 font-mono text-xs">{account.botUserId}</dd>
          </div>
          <div>
            <dt className="text-xs muted">会話 Webhook URL</dt>
            <dd className="mt-1 font-mono text-xs break-all">{account.webhookUrl || account.webhookPath}</dd>
          </div>
        </dl>
      ) : null}
      {!account || token || secret ? (
        <div className="space-y-2">
          <label className="block text-xs">
            チャネルアクセストークン
            <input
              type="password"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-[var(--border-soft)] bg-transparent px-2 py-2 text-sm"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy || disabled}
            />
          </label>
          <label className="block text-xs">
            チャネルシークレット
            <input
              type="password"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-[var(--border-soft)] bg-transparent px-2 py-2 text-sm"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={busy || disabled}
            />
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {!account ? (
          <button
            type="button"
            className="text-xs underline underline-offset-2 min-h-[44px]"
            disabled={busy || disabled || !token || !secret}
            onClick={() => void submit(true)}
          >
            {busy ? "接続中…" : "接続して Webhook を登録"}
          </button>
        ) : (
          <button
            type="button"
            className="text-xs underline underline-offset-2 min-h-[44px]"
            disabled={busy || disabled}
            onClick={() => void submit(Boolean(token && secret))}
          >
            {busy ? "登録中…" : token && secret ? "トークンを更新して Webhook を再登録" : "Webhook を再登録してテスト"}
          </button>
        )}
      </div>
      {okMessage ? <p className="text-xs">{okMessage}</p> : null}
      {message ? <p className="text-xs text-[var(--danger)]">{message}</p> : null}
    </div>
  );
}
