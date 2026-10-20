"use client";

import { useState } from "react";
import {
  LINE_COMM_ACCOUNT_BOT_USER_LABEL_JA,
  LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA,
  LINE_COMM_ACCOUNT_CONNECTING_JA,
  LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA,
  LINE_COMM_ACCOUNT_HELP_JA,
  LINE_COMM_ACCOUNT_REGISTERING_JA,
  LINE_COMM_ACCOUNT_RETEST_BUTTON_JA,
  LINE_COMM_ACCOUNT_SECRET_LABEL_JA,
  LINE_COMM_ACCOUNT_SUCCESS_JA,
  LINE_COMM_ACCOUNT_SUCCESS_WITH_URL_JA,
  LINE_COMM_ACCOUNT_TOKEN_LABEL_JA,
  LINE_COMM_ACCOUNT_UPDATE_BUTTON_JA,
  LINE_COMM_ACCOUNT_WEBHOOK_LABEL_JA,
} from "@/lib/comm/line-poc-copy";

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
      if (!res.ok || !body.ok) throw new Error(body.message || body.error || LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA);
      setToken("");
      setSecret("");
      setOkMessage(body.webhookUrl ? LINE_COMM_ACCOUNT_SUCCESS_WITH_URL_JA(body.webhookUrl) : LINE_COMM_ACCOUNT_SUCCESS_JA);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs muted leading-relaxed">
        {LINE_COMM_ACCOUNT_HELP_JA}
      </p>
      {account ? (
        <dl className="text-sm space-y-2">
          <div>
            <dt className="text-xs muted">{LINE_COMM_ACCOUNT_BOT_USER_LABEL_JA}</dt>
            <dd className="mt-1 font-mono text-xs">{account.botUserId}</dd>
          </div>
          <div>
            <dt className="text-xs muted">{LINE_COMM_ACCOUNT_WEBHOOK_LABEL_JA}</dt>
            <dd className="mt-1 font-mono text-xs break-all">{account.webhookUrl || account.webhookPath}</dd>
          </div>
        </dl>
      ) : null}
      {!account || token || secret ? (
        <div className="space-y-2">
          <label className="block text-xs">
            {LINE_COMM_ACCOUNT_TOKEN_LABEL_JA}
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
            {LINE_COMM_ACCOUNT_SECRET_LABEL_JA}
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
            {busy ? LINE_COMM_ACCOUNT_CONNECTING_JA : LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA}
          </button>
        ) : (
          <button
            type="button"
            className="text-xs underline underline-offset-2 min-h-[44px]"
            disabled={busy || disabled}
            onClick={() => void submit(Boolean(token && secret))}
          >
            {busy ? LINE_COMM_ACCOUNT_REGISTERING_JA : token && secret ? LINE_COMM_ACCOUNT_UPDATE_BUTTON_JA : LINE_COMM_ACCOUNT_RETEST_BUTTON_JA}
          </button>
        )}
      </div>
      {okMessage ? <p className="text-xs">{okMessage}</p> : null}
      {message ? <p className="text-xs text-[var(--danger)]">{message}</p> : null}
    </div>
  );
}
