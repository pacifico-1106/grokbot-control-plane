"use client";

import { useState } from "react";
import { CopyableValue } from "@/components/CopyableValue";
import { STAFFPASS_ADMIN_MCP_URL } from "@/lib/mcp/admin-public";

export function AdminMcpConnect({
  connected,
  grokBotAgentId,
}: {
  connected: boolean;
  grokBotAgentId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(grokBotAgentId || "");
  const [message, setMessage] = useState("");
  const [isConnected, setConnected] = useState(connected);

  async function issue() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin-mcp/issue", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "発行に失敗しました");
      setSecret(body.credential?.oneTimeSecret || null);
      setMessage(body.credential?.noticeJa || "管理MCPの認証を発行しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "発行に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin-mcp/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grokBotAgentId: agentId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "接続に失敗しました");
      setConnected(true);
      setMessage("管理エージェントを接続しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "接続に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="admin-mcp" className="surface p-5 space-y-3">
      <p className="text-xs faint font-mono">STEP 02</p>
      <h2 className="text-sm font-medium">admin MCP 接続</h2>
      <p className="text-sm muted leading-relaxed">
        テナントに管理エージェントは1つです。社員証 MCP（gb_emp_）とは別口です。ヘッダを混ぜないでください。
      </p>
      <div>
        <p className="text-xs muted mb-1.5">管理MCP URL</p>
        <CopyableValue value={STAFFPASS_ADMIN_MCP_URL} />
      </div>
      <p className="text-xs muted">
        認証は <code className="text-[11px]">Authorization: Bearer gb_adm_…</code>
        。社員証の gb_emp_ は拒否します。
      </p>
      <button type="button" className="btn btn-primary text-sm" disabled={busy} onClick={() => void issue()}>
        {busy ? "処理中…" : "管理用の認証を発行"}
      </button>
      {secret ? (
        <div className="space-y-1">
          <p className="text-xs muted">一度だけ表示（ログに残しません）</p>
          <CopyableValue value={secret} />
        </div>
      ) : null}
      <label className="block text-sm">
        <span className="muted">Grok Bot エージェント ID</span>
        <input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          placeholder="grok_…"
          disabled={busy}
        />
      </label>
      <button type="button" className="btn btn-ghost text-sm" disabled={busy || !agentId.trim()} onClick={() => void link()}>
        接続する
      </button>
      <p className="text-xs muted">{isConnected ? "接続済み" : "未接続"}{message ? ` · ${message}` : ""}</p>
    </section>
  );
}
