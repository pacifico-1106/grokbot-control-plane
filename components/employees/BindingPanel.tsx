"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { policyErrorMessage } from "@/lib/employees/policy-errors";
import type { BindingStatus, EmployeeBinding } from "@/lib/types";

const STATUS_LABEL: Record<BindingStatus, string> = {
  unlinked: "未接続",
  linked: "接続中",
  degraded: "不安定",
  needs_reauth: "再接続が必要",
  revoked: "取消済み",
};

function chipClass(status: BindingStatus): string {
  if (status === "linked") return "chip chip-ok";
  if (status === "needs_reauth" || status === "degraded") return "chip chip-warn";
  if (status === "revoked") return "chip chip-danger";
  return "chip";
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  } catch {
    return iso;
  }
}

export function BindingPanel({
  employeeId,
  initial,
}: {
  employeeId: string;
  initial: EmployeeBinding;
}) {
  const [binding, setBinding] = useState<EmployeeBinding>(initial);
  const [agentId, setAgentId] = useState(initial.grokBotAgentId ?? "");
  const [workspaceId, setWorkspaceId] = useState(
    initial.grokBotWorkspaceId ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [wakeUrl, setWakeUrl] = useState(initial.wakeWebhookUrl ?? "");
  const [wakeSecret, setWakeSecret] = useState("");
  const [hasWakeWebhook, setHasWakeWebhook] = useState(Boolean(initial.hasWakeWebhook));

  const applyBinding = useCallback((b: EmployeeBinding) => {
    setBinding(b);
    setAgentId(b.grokBotAgentId ?? "");
    setWorkspaceId(b.grokBotWorkspaceId ?? "");
    setWakeUrl(b.wakeWebhookUrl ?? "");
    setHasWakeWebhook(Boolean(b.hasWakeWebhook));
  }, []);

  async function link() {
    setBusy(true);
    setMessage("");
    setOneTimeSecret(null);
    setRevealSecret(false);
    try {
      const res = await fetch(`/api/employees/${employeeId}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grokBotAgentId: agentId,
          grokBotWorkspaceId: workspaceId || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(policyErrorMessage(body, "連携に失敗しました"));
      applyBinding(body.binding);
      setMessage(body.message || "連携しました");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function health(forceFail = false) {
    setBusy(true);
    setMessage("");
    try {
      const q = forceFail ? "?forceFail=1" : "";
      const res = await fetch(`/api/employees/${employeeId}/health${q}`, {
        method: "POST",
      });
      const body = await res.json();
      if (body.binding) applyBinding(body.binding);
      setMessage(body.message || (body.ok ? "OK" : "NG"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    setMessage("");
    setOneTimeSecret(null);
    try {
      const res = await fetch(`/api/employees/${employeeId}/rotate`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || "rotate_failed");
      applyBinding(body.binding);
      setOneTimeSecret(body.credential?.oneTimeSecret ?? null);
      setRevealSecret(false);
      setCopiedSecret(false);
      setMessage(
        body.credential?.notice ||
          `社員証を出し直しました（世代 ${body.generation}。AI社員番号は変わりません）`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveWake() {
    setBusy(true);
    setMessage("");
    try {
      const payload: Record<string, string> = { wakeWebhookUrl: wakeUrl.trim() };
      if (wakeSecret.trim()) payload.wakeWebhookSecret = wakeSecret.trim();
      const res = await fetch(`/api/employees/${employeeId}/binding`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(policyErrorMessage(body, "保存に失敗しました"));
      if (body.binding) applyBinding(body.binding);
      setWakeSecret("");
      setMessage(body.message || "起こす webhook を保存しました");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const needsReauth = binding.status === "needs_reauth";

  return (
    <section id="binding" className="surface p-5 mt-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Grok Bot の接続状態</h2>
          <p className="mt-1 text-xs muted leading-relaxed">
            AI社員の番号はずっと変わりません。社員証を出し直しても、同じ人として扱います。
          </p>
          <p className="mt-1 text-xs muted leading-relaxed">
            Grok Bot は Plugins（リモート MCP）でつなぎます。URL と手順は{" "}
            <Link href="/app/integrations#mcp" className="underline underline-offset-2">
              連携
            </Link>
            。社員証（接続用の鍵）は雇ったときに一度だけ表示されます。
          </p>
        </div>
        <span className={chipClass(binding.status)}>
          {STATUS_LABEL[binding.status]}
        </span>
      </div>

      {needsReauth ? (
        <div
          className="rounded-lg border px-3 py-2.5 text-sm"
          style={{
            borderColor: "color-mix(in oklab, var(--warn) 45%, var(--border))",
            background: "color-mix(in oklab, var(--warn) 10%, transparent)",
            color: "var(--warn)",
          }}
          role="alert"
        >
          <strong>再接続が必要</strong>
          <span className="muted text-xs ml-2" style={{ color: "var(--text-muted)" }}>
            つながり情報は消していません。社員証を出し直すか、接続を回復してください。
          </span>
          {binding.lastError ? (
            <div className="mt-1 text-[11px] faint">
              前回のエラー: {binding.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      <dl className="grid sm:grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs muted">AI社員番号（変更なし）</dt>
          <dd className="mt-1 font-mono text-xs">{binding.employeeId}</dd>
        </div>
        <div>
          <dt className="text-xs muted">社員証の世代</dt>
          <dd className="mt-1 font-mono text-xs">{binding.credentialGeneration}</dd>
        </div>
        <div>
          <dt className="text-xs muted">最後に成功した時刻</dt>
          <dd className="mt-1 text-xs">{formatTs(binding.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt className="text-xs muted">接続用の鍵（指紋）</dt>
          <dd className="mt-1 font-mono text-[11px] truncate">
            {binding.credentialFingerprint
              ? `${binding.credentialFingerprint.slice(0, 16)}…`
              : "—"}
          </dd>
        </div>
      </dl>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="text-xs muted">Grok Bot のエージェントID</span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm font-mono"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="gba_…"
            disabled={busy || binding.status === "revoked"}
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs muted">ワークスペースID（任意）</span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm font-mono"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="gbw_…"
            disabled={busy || binding.status === "revoked"}
          />
        </label>
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--border-soft)] p-3">
        <div>
          <h3 className="text-sm font-medium">この社員を起こす webhook</h3>
          <p className="mt-1 text-xs muted leading-relaxed">
            Grok Bot の webhook ルーチンからコピー。Cursor Slack 接続は不要。
          </p>
        </div>
        <label className="block text-sm">
          <span className="text-xs muted">URL</span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm font-mono"
            value={wakeUrl}
            onChange={(e) => setWakeUrl(e.target.value)}
            placeholder="https://"
            autoComplete="off"
            disabled={busy || binding.status === "revoked"}
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs muted">送信キー（secret）</span>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm font-mono"
            value={wakeSecret}
            onChange={(e) => setWakeSecret(e.target.value)}
            placeholder={hasWakeWebhook ? "保存済み（変更するときだけ入力）" : "Grok Bot の送信キー"}
            autoComplete="new-password"
            disabled={busy || binding.status === "revoked"}
          />
        </label>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          disabled={busy || binding.status === "revoked"}
          onClick={() => void saveWake()}
        >
          起こす webhook を保存
        </button>
      </div>

      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary text-sm w-full sm:w-auto"
          disabled={busy || binding.status === "revoked" || !agentId.trim()}
          onClick={() => void link()}
        >
          連携する
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm w-full sm:w-auto"
          disabled={busy || binding.status === "revoked"}
          onClick={() => void health(false)}
        >
          接続を確認
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm w-full sm:w-auto"
          disabled={busy || binding.status === "revoked"}
          onClick={() => void rotate()}
        >
          社員証を再発行
        </button>
        <button
          type="button"
          className="btn btn-ghost text-xs w-full sm:w-auto"
          disabled={busy}
          onClick={() => void health(true)}
          title="デモ用: 接続切れを試す"
        >
          接続切れを試す（デモ）
        </button>
      </div>

      <p className="text-[11px] faint leading-relaxed">
        社員証を出し直しても、AI社員の番号は変わりません。未接続・取消・再接続待ちのときは、承認されるまで実行しません。
      </p>

      {oneTimeSecret ? (
        <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
          <div className="text-xs muted">一度だけの接続用の鍵（コピーして保管）</div>
          <code className="block break-all text-xs font-mono">
            {revealSecret ? oneTimeSecret : "••••••••••••••••••••••••••••••••"}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-ghost text-xs px-3 py-1.5"
              onClick={() => setRevealSecret((v) => !v)}
            >
              {revealSecret ? "隠す" : "表示"}
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs px-3 py-1.5"
              onClick={() => {
                void navigator.clipboard.writeText(oneTimeSecret).then(() => {
                  setCopiedSecret(true);
                  setTimeout(() => setCopiedSecret(false), 2000);
                });
              }}
            >
              {copiedSecret ? "コピーしました" : "コピー"}
            </button>
          </div>
        </div>
      ) : null}

      {message ? <p className="text-xs muted">{message}</p> : null}
    </section>
  );
}
