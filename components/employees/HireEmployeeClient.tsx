"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  APPROVAL_POLICY_LABELS,
  SCOPE_LABELS,
} from "@/lib/employees/policy-draft";
import type {
  ApprovalPolicy,
  EmployeePolicyDraft,
  EmployeeScope,
} from "@/lib/types";

const EXAMPLES = [
  "営業として見積メールの下書きを作り、送信前に必ず承認してほしい",
  "事務として請求書を確認し、社内ファイルを読むだけ",
  "顧客対応の返信下書きと、必要ならメール送信（承認付き）",
  "購買で発注まで行うが、毎回人間の承認が必要",
];

type Step = "describe" | "draft" | "issued";

export function HireEmployeeClient() {
  const [step, setStep] = useState<Step>("describe");
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<EmployeePolicyDraft | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [scopes, setScopes] = useState<EmployeeScope[]>([]);
  const [purposes, setPurposes] = useState("");
  const [approvalPolicy, setApprovalPolicy] =
    useState<ApprovalPolicy>("risk_based");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [issuedEmployeeId, setIssuedEmployeeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const purposeList = useMemo(
    () =>
      purposes
        .split(/[,、\n]/)
        .map((p) => p.trim())
        .filter(Boolean),
    [purposes]
  );

  async function createDraft() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/employees/interpret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: prompt }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "interpret_failed");
      const d = body.draft as EmployeePolicyDraft;
      setDraft(d);
      setDisplayName(d.policy.displayName);
      setRoleLabel(d.policy.roleLabel);
      setScopes(d.policy.scopes);
      setPurposes(d.policy.allowedPurposes.join(", "));
      setApprovalPolicy(d.policy.approvalPolicy);
      setExpiresInDays(d.policy.expiresInDays);
      setStep("draft");
    } catch (e) {
      setError(e instanceof Error ? e.message : "interpret_failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleScope(scope: EmployeeScope) {
    setScopes((cur) =>
      cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]
    );
  }

  async function issueCredential() {
    if (!displayName.trim() || !roleLabel.trim() || !scopes.length) {
      setError("名前・職務・スコープは必須です");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/employees/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName,
          roleLabel,
          jobDescription: prompt,
          scopes,
          allowedPurposes: purposeList,
          approvalPolicy,
          expiresInDays,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "issue_failed");
      setOneTimeSecret(body.credential?.oneTimeSecret ?? null);
      setIssuedEmployeeId(body.employee?.id ?? null);
      setStep("issued");
    } catch (e) {
      setError(e instanceof Error ? e.message : "issue_failed");
    } finally {
      setLoading(false);
    }
  }

  async function copySecret() {
    if (!oneTimeSecret) return;
    await navigator.clipboard.writeText(oneTimeSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {[
          { id: "describe", label: "1. 職務を説明" },
          { id: "draft", label: "2. Draft を確認" },
          { id: "issued", label: "3. 社員証発行" },
        ].map((s) => (
          <li
            key={s.id}
            className={`chip ${step === s.id ? "chip-ok" : ""}`}
          >
            {s.label}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="rounded-lg border border-[color-mix(in_oklab,var(--danger)_40%,var(--border))] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {step === "describe" ? (
        <section className="surface p-5 space-y-4">
          <div>
            <h2 className="text-sm font-medium">このAI社員に何を任せますか？</h2>
            <p className="mt-2 text-sm muted leading-relaxed">
              日本語で職務を書くと、最小権限の Draft（スコープ・目的・承認ポリシー）に変換します。
              確認して確定するまで社員証は発行されません。
            </p>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--text-faint)]"
            placeholder="例: 営業として見積の下書き…"
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip hover:text-[var(--text)]"
                onClick={() => setPrompt(ex)}
              >
                {ex.slice(0, 18)}…
              </button>
            ))}
          </div>
          <p className="text-xs faint">
            APIキー・secret・秘密鍵は入力しないでください。
          </p>
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={loading || !prompt.trim()}
            onClick={() => void createDraft()}
          >
            {loading ? "変換中…" : "職務権限 Draft を作る"}
          </button>
        </section>
      ) : null}

      {step === "draft" && draft ? (
        <section className="surface p-5 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Draft を確認・編集</h2>
              <p className="mt-1 text-xs faint">
                信頼度 {(draft.confidence * 100).toFixed(0)}% · source={draft.source}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost text-xs px-3 py-1.5"
              onClick={() => setStep("describe")}
            >
              説明に戻る
            </button>
          </div>

          {(draft.assumptions.length > 0 || draft.warnings.length > 0) && (
            <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] p-3 space-y-2">
              {draft.assumptions.map((a) => (
                <p key={a} className="text-xs muted">
                  仮定: {a}
                </p>
              ))}
              {draft.warnings.map((w) => (
                <p key={w} className="text-xs text-[var(--warn)]">
                  注意: {w}
                </p>
              ))}
              {draft.missingFields.length > 0 ? (
                <p className="text-xs faint">
                  不足: {draft.missingFields.join(", ")}
                </p>
              ) : null}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="muted">表示名</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="muted">職務ラベル</span>
              <input
                value={roleLabel}
                onChange={(e) => setRoleLabel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="muted">許可目的（カンマ区切り）</span>
            <input
              value={purposes}
              onChange={(e) => setPurposes(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            />
          </label>

          <div>
            <div className="text-sm muted mb-2">スコープ</div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(SCOPE_LABELS) as EmployeeScope[]).map((scope) => {
                const on = scopes.includes(scope);
                return (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => toggleScope(scope)}
                    className={`chip ${on ? "chip-ok" : ""}`}
                  >
                    {SCOPE_LABELS[scope]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="muted">承認ポリシー</span>
              <select
                value={approvalPolicy}
                onChange={(e) =>
                  setApprovalPolicy(e.target.value as ApprovalPolicy)
                }
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              >
                {(Object.keys(APPROVAL_POLICY_LABELS) as ApprovalPolicy[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {APPROVAL_POLICY_LABELS[k]}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="block text-sm">
              <span className="muted">有効期限（日）</span>
              <input
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value) || 30)}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={loading}
            onClick={() => void issueCredential()}
          >
            {loading ? "発行中…" : "確認して社員証を発行"}
          </button>
        </section>
      ) : null}

      {step === "issued" ? (
        <section className="surface p-5 space-y-4">
          <div className="chip chip-ok">発行完了（デモ）</div>
          <h2 className="text-lg font-medium">{displayName}</h2>
          <p className="text-sm muted">
            {roleLabel} · 承認: {APPROVAL_POLICY_LABELS[approvalPolicy]}
          </p>
          <div className="rounded-lg border border-[var(--warn)]/40 bg-[var(--bg-soft)] p-4">
            <p className="text-xs text-[var(--warn)] font-medium">
              この秘密値は一度だけ表示されます
            </p>
            <pre className="mt-3 text-xs font-mono break-all whitespace-pre-wrap">
              {oneTimeSecret}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary text-xs px-3 py-1.5"
                onClick={() => void copySecret()}
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
              <Link
                href="/app/integrations"
                className="btn btn-ghost text-xs px-3 py-1.5"
              >
                Grok Bot へ連携
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/app/employees" className="btn btn-ghost text-sm">
              AI社員一覧へ
            </Link>
            {issuedEmployeeId ? (
              <Link
                href={`/app/employees/${issuedEmployeeId}`}
                className="btn btn-ghost text-sm"
              >
                詳細
              </Link>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={() => {
                setStep("describe");
                setDraft(null);
                setOneTimeSecret(null);
                setPrompt(EXAMPLES[0]);
              }}
            >
              もう一人雇う
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
