"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ACCOUNT_SERVICE_PRESETS,
  emptyAllowedAccount,
  normalizeAllowedAccounts,
} from "@/lib/employees/allowed-accounts";
import {
  alwaysHumanMustList,
  denyDefaultList,
} from "@/lib/employees/approval-presets";
import {
  APPROVAL_POLICY_LABELS,
  SCOPE_LABELS,
  jobTextImpliesCommerceOrder,
} from "@/lib/employees/policy-draft";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";
import type {
  AllowedAccount,
  ApprovalPolicy,
  EmployeePolicyDraft,
  EmployeeScope,
  SpendLimits,
} from "@/lib/types";

const EXAMPLES = [
  "営業として見積メールの下書きを作り、送信前に必ず承認してほしい",
  "事務として請求書を確認し、社内ファイルを読むだけ",
  "顧客対応の返信下書きと、必要ならメール送信（承認付き）",
  "購買で発注まで行うが、毎回人間の承認が必要",
];

const MERCHANT_CHIPS = ["eSIMのみ", "オフィス消耗品", "クラウドSaaS", "指定なし"];

type Step = "describe" | "draft" | "spend" | "issued";

function emptySpend(): SpendLimits {
  return { ...DEFAULT_SPEND_LIMITS };
}

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
  const [spend, setSpend] = useState<SpendLimits>(emptySpend);
  const [futureSpendOpen, setFutureSpendOpen] = useState(false);
  const [browserAllowed, setBrowserAllowed] = useState(false);
  const [allowedAccounts, setAllowedAccounts] = useState<AllowedAccount[]>([]);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);
  const [orderInferredFromJob, setOrderInferredFromJob] = useState(false);
  const [issuedEmployeeId, setIssuedEmployeeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hirePack, setHirePack] = useState<{
    instructionsSnippet: string;
    routineText: string;
    noticeJa?: string;
  } | null>(null);
  const [copiedPack, setCopiedPack] = useState<"instructions" | "routine" | null>(
    null
  );

  const purposeList = useMemo(
    () =>
      purposes
        .split(/[,、\n]/)
        .map((p) => p.trim())
        .filter(Boolean),
    [purposes]
  );

  const hasOrderScope = scopes.includes("commerce:order");

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
      // Auto-enable commerce:order when job text implies ordering (also enforced in rules).
      const inferredOrder =
        jobTextImpliesCommerceOrder(prompt) ||
        d.policy.scopes.includes("commerce:order") ||
        d.warnings.includes("commerce_order_requested");
      const nextScopes = inferredOrder && !d.policy.scopes.includes("commerce:order")
        ? ([...d.policy.scopes, "commerce:order", "commerce:quote"] as EmployeeScope[])
        : d.policy.scopes;
      setOrderInferredFromJob(inferredOrder);
      const scopesUnique = [...new Set(nextScopes)] as EmployeeScope[];
      setScopes(scopesUnique);
      setPurposes(d.policy.allowedPurposes.join(", "));
      setApprovalPolicy(d.policy.approvalPolicy);
      setExpiresInDays(d.policy.expiresInDays);
      setSpend(
        scopesUnique.includes("commerce:order")
          ? { ...DEFAULT_SPEND_LIMITS, ...(d.policy.spend ?? {}) }
          : emptySpend()
      );
      setFutureSpendOpen(false);
      const hasBrowser = d.policy.scopes.includes("browser:use");
      setBrowserAllowed(hasBrowser);
      setAllowedAccounts(
        d.policy.allowedAccounts?.length
          ? d.policy.allowedAccounts.map((a) => ({ ...a }))
          : hasBrowser
            ? [emptyAllowedAccount("google")]
            : []
      );
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

  function goToSpendOrIssue() {
    if (!displayName.trim() || !roleLabel.trim() || !scopes.length) {
      setError("名前・職務・できることは必須です");
      return;
    }
    setError("");
    setStep("spend");
  }

  async function issueCredential() {
    if (!displayName.trim() || !roleLabel.trim() || !scopes.length) {
      setError("名前・職務・できることは必須です");
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
          scopes: (() => {
            const next = new Set(scopes);
            if (browserAllowed) next.add("browser:use");
            else next.delete("browser:use");
            return [...next];
          })(),
          allowedPurposes: purposeList,
          approvalPolicy,
          expiresInDays,
          spend: hasOrderScope || futureSpendOpen ? spend : null,
          allowedAccounts: normalizeAllowedAccounts(allowedAccounts),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "issue_failed");
      setOneTimeSecret(body.credential?.oneTimeSecret ?? null);
      setRevealSecret(false);
      setIssuedEmployeeId(body.employee?.id ?? null);
      setHirePack(
        body.hirePack &&
          typeof body.hirePack.instructionsSnippet === "string" &&
          typeof body.hirePack.routineText === "string"
          ? {
              instructionsSnippet: body.hirePack.instructionsSnippet,
              routineText: body.hirePack.routineText,
              noticeJa:
                typeof body.hirePack.noticeJa === "string"
                  ? body.hirePack.noticeJa
                  : undefined,
            }
          : null
      );
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

  async function copyPack(kind: "instructions" | "routine") {
    if (!hirePack) return;
    const text =
      kind === "instructions"
        ? hirePack.instructionsSnippet
        : hirePack.routineText;
    await navigator.clipboard.writeText(text);
    setCopiedPack(kind);
    setTimeout(() => setCopiedPack(null), 2000);
  }

  function patchSpend(partial: Partial<SpendLimits>) {
    setSpend((s) => ({ ...s, ...partial }));
  }

  const stepsMeta: Array<{ id: Step; label: string }> = [
    { id: "describe", label: "1. 職務説明" },
    { id: "draft", label: "2. 権限の案" },
    { id: "spend", label: "3. 予算・承認" },
    { id: "issued", label: "4. 発行" },
  ];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {stepsMeta.map((s) => (
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
              日本語で職務を書くと、最小限の権限の案（できること・目的・承認のルール）に変換します。
              発注がある場合は、次のステップで予算上限も決められます。確認するまで社員証は発行されません。
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
                className="chip hover:text-[var(--text)] max-w-full break-words text-left"
                onClick={() => setPrompt(ex)}
              >
                {ex.slice(0, 18)}…
              </button>
            ))}
          </div>
          <p className="text-xs faint">
            パスワードや接続用の鍵、秘密の番号は入力しないでください。
          </p>
          <button
            type="button"
            className="btn btn-primary text-sm w-full sm:w-auto"
            disabled={loading || !prompt.trim()}
            onClick={() => void createDraft()}
          >
            {loading ? "変換中…" : "権限の案を作る"}
          </button>
        </section>
      ) : null}

      {step === "draft" && draft ? (
        <section className="surface p-5 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">権限の案を確認・編集</h2>
              <p className="mt-1 text-xs faint">
                この案の確からしさ {(draft.confidence * 100).toFixed(0)}%
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


          {orderInferredFromJob && scopes.includes("commerce:order") ? (
            <div
              className="rounded-lg border px-3 py-2.5 text-sm leading-relaxed"
              style={{
                borderColor: "color-mix(in oklab, var(--warn) 45%, var(--border))",
                background: "color-mix(in oklab, var(--warn) 10%, transparent)",
              }}
              role="status"
            >
              <strong style={{ color: "var(--warn)" }}>発注権限を追加しました</strong>
              <span className="muted block sm:inline sm:ml-2 text-xs mt-1 sm:mt-0">
                職務から発注が必要と読み取りました。外すこともできます。
              </span>
            </div>
          ) : null}

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
            <div className="text-sm muted mb-2">できること</div>
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
              <span className="muted">承認ポリシー（全体）</span>
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

          <details className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium">
              中小企業向け・必ず人が確認する操作（初期設定）
            </summary>
            <p className="mt-2 text-[11px] muted leading-relaxed">
              「誰が承認ボタンを押せるか」とは別の話です。送信・確定は必ず人が確認。下書き・提案だけ自動にできます。
            </p>
            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed">
              {alwaysHumanMustList().map((row) => (
                <li key={row.tool}>
                  <span className="font-medium text-[var(--text)]">{row.labelJa}</span>
                  <span className="muted"> — 人が確認</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] muted">
              禁止デフォルト:{" "}
              {denyDefaultList()
                .map((r) => r.labelJa)
                .join(" / ")}
            </p>
          </details>

          <button
            type="button"
            className="btn btn-primary text-sm w-full sm:w-auto"
            disabled={loading}
            onClick={goToSpendOrIssue}
          >
            次へ：予算・承認の補足
          </button>
        </section>
      ) : null}

      {step === "spend" ? (
        <section className="surface p-5 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">予算・承認（補足ヒアリング）</h2>
              <p className="mt-2 text-sm muted leading-relaxed">
                社長が決める「いくらまで自動でよいか」。迷ったら「常に人間承認」のままで大丈夫です。後から変えられます。
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost text-xs px-3 py-1.5"
              onClick={() => setStep("draft")}
            >
              権限の案に戻る
            </button>
          </div>

          {draft?.policy.spendRecommendation ? (
            <p className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2 text-xs text-[var(--warn)] leading-relaxed">
              推奨: {draft.policy.spendRecommendation}
            </p>
          ) : null}

          <p className="rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2 text-xs muted leading-relaxed">
            <span className="font-medium text-[var(--text)]">運用ルール: </span>
            実際の発注・送信は、当社の承認ルート経由だけです。AI社員に直結の道具は載せません。
            （Staffpass が断れば、その操作は進みません）
          </p>

          {hasOrderScope ? (
            <SpendForm
              approvalPolicy={approvalPolicy}
              setApprovalPolicy={setApprovalPolicy}
              spend={spend}
              patchSpend={patchSpend}
            />
          ) : (
            <div className="rounded-lg border border-[var(--border-soft)] p-4 space-y-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left text-sm"
                onClick={() => setFutureSpendOpen((v) => !v)}
              >
                <span className="font-medium">将来の決済委任（任意・折りたたみ）</span>
                <span className="chip text-[11px]">
                  {futureSpendOpen ? "閉じる" : "開く"}
                </span>
              </button>
              <p className="text-xs muted leading-relaxed">
                いまは発注の権限がありません。必要になったときのために、予算の考え方だけ先にメモできます。予算未設定のまま発注を足すと、承認されるまで実行しません。
              </p>
              {futureSpendOpen ? (
                <SpendForm
                  approvalPolicy={approvalPolicy}
                  setApprovalPolicy={setApprovalPolicy}
                  spend={spend}
                  patchSpend={patchSpend}
                />
              ) : null}
            </div>
          )}

          <BrowserAccountsSection
            browserAllowed={browserAllowed}
            setBrowserAllowed={(on) => {
              setBrowserAllowed(on);
              setScopes((cur) => {
                const next = new Set(cur);
                if (on) next.add("browser:use");
                else next.delete("browser:use");
                return [...next];
              });
              if (on && allowedAccounts.length === 0) {
                setAllowedAccounts([emptyAllowedAccount("google")]);
              }
            }}
            allowedAccounts={allowedAccounts}
            setAllowedAccounts={setAllowedAccounts}
          />

          <div className="flex flex-col sm:flex-row flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary text-sm w-full sm:w-auto"
              disabled={loading}
              onClick={() => void issueCredential()}
            >
              {loading ? "発行中…" : "確認して社員証を発行"}
            </button>
          </div>
        </section>
      ) : null}

      {step === "issued" ? (
        <section className="surface p-5 space-y-4">
          <div className="chip chip-ok">発行完了</div>
          <h2 className="text-lg font-medium">{displayName}</h2>
          <p className="text-sm muted">
            {roleLabel} · 承認: {APPROVAL_POLICY_LABELS[approvalPolicy]}
          </p>
          {hasOrderScope || futureSpendOpen ? (
            <p className="text-xs muted">
              予算: 1件あたり最大 ¥{spend.maxPerOrderJpy.toLocaleString("ja-JP")}
              {spend.firstOrderRequiresHuman !== false ? " · 初回は人間承認" : ""}
              {spend.merchantAllowTip ? ` · ヒント: ${spend.merchantAllowTip}` : ""}
            </p>
          ) : null}
          {browserAllowed || normalizeAllowedAccounts(allowedAccounts).length > 0 ? (
            <p className="text-xs muted">
              ブラウザ: {browserAllowed ? "許可" : "未許可"}
              {normalizeAllowedAccounts(allowedAccounts).length
                ? ` · 許可ID ${normalizeAllowedAccounts(allowedAccounts).length}件`
                : ""}
            </p>
          ) : null}
          <div className="rounded-lg border border-[var(--warn)]/40 bg-[var(--bg-soft)] p-4">
            <p className="text-xs text-[var(--warn)] font-medium">
              この接続用の鍵は一度だけ表示されます
            </p>
            <pre className="mt-3 text-xs font-mono break-all whitespace-pre-wrap">
              {oneTimeSecret
                ? revealSecret
                  ? oneTimeSecret
                  : "••••••••••••••••••••••••••••••••"
                : "—"}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-ghost text-xs px-3 py-1.5"
                disabled={!oneTimeSecret}
                onClick={() => setRevealSecret((v) => !v)}
              >
                {revealSecret ? "隠す" : "表示"}
              </button>
              <button
                type="button"
                className="btn btn-primary text-xs px-3 py-1.5"
                onClick={() => void copySecret()}
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
              {issuedEmployeeId ? (
                <Link
                  href={`/app/employees/${issuedEmployeeId}#binding`}
                  className="btn btn-ghost text-xs px-3 py-1.5"
                >
                  社員詳細で Agent ID を入れて連携
                </Link>
              ) : (
                <Link
                  href="/app/employees"
                  className="btn btn-ghost text-xs px-3 py-1.5"
                >
                  社員詳細で Agent ID を入れて連携
                </Link>
              )}
            </div>
          </div>
          {hirePack ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] p-4 space-y-3">
              <h3 className="text-sm font-medium">Instructions / Routine（必須）</h3>
              <p className="text-xs muted leading-relaxed">
                {hirePack.noticeJa ||
                  "needs_approval 時は停止し、署名付き status poll を承認結果まで待ってください。Partner webhook が来るまで poll が正本です。"}
              </p>
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <span className="text-xs muted">Base 承認待ちルール（Instructions）</span>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs px-2 py-1 min-h-[40px]"
                    onClick={() => void copyPack("instructions")}
                  >
                    {copiedPack === "instructions" ? "コピー済み" : "コピー"}
                  </button>
                </div>
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-3">
                  {hirePack.instructionsSnippet}
                </pre>
              </div>
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <span className="text-xs muted">Routine テンプレ（Teach / Routines）</span>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs px-2 py-1 min-h-[40px]"
                    onClick={() => void copyPack("routine")}
                  >
                    {copiedPack === "routine" ? "コピー済み" : "コピー"}
                  </button>
                </div>
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-3">
                  {hirePack.routineText}
                </pre>
              </div>
              <Link
                href="/app/guides/approval-loop"
                className="text-xs underline underline-offset-2"
              >
                承認ループ運用ガイド
              </Link>
            </div>
          ) : null}
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
                setHirePack(null);
                setSpend(emptySpend());
                setBrowserAllowed(false);
                setAllowedAccounts([]);
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

function SpendForm({
  approvalPolicy,
  setApprovalPolicy,
  spend,
  patchSpend,
}: {
  approvalPolicy: ApprovalPolicy;
  setApprovalPolicy: (p: ApprovalPolicy) => void;
  spend: SpendLimits;
  patchSpend: (p: Partial<SpendLimits>) => void;
}) {
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm muted">購入の承認モード</legend>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="purchaseApproval"
            className="mt-1"
            checked={approvalPolicy === "always_human"}
            onChange={() => setApprovalPolicy("always_human")}
          />
          <span>
            <span className="font-medium">常に人間が承認</span>
            <span className="block text-xs muted mt-0.5">
              安心優先。少額でも毎回社長（または管理者）が OK します。
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="purchaseApproval"
            className="mt-1"
            checked={approvalPolicy === "risk_based"}
            onChange={() => setApprovalPolicy("risk_based")}
          />
          <span>
            <span className="font-medium">少額は自動（リスクベース）</span>
            <span className="block text-xs muted mt-0.5">
              下の上限以内だけ自動。超えたら承認待ち。上限未設定は自動しません。
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="block text-sm">
          <span className="muted">1件あたり上限（円）</span>
          <input
            type="number"
            min={0}
            value={spend.maxPerOrderJpy}
            onChange={(e) =>
              patchSpend({ maxPerOrderJpy: Number(e.target.value) || 0 })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[11px] faint">
            目安 3,000。0 = 発注禁止（自動不可）
          </span>
        </label>
        <label className="block text-sm">
          <span className="muted">1日あたり上限（任意）</span>
          <input
            type="number"
            min={0}
            placeholder="未設定"
            value={spend.maxPerDayJpy ?? ""}
            onChange={(e) =>
              patchSpend({
                maxPerDayJpy:
                  e.target.value === "" ? null : Number(e.target.value) || 0,
              })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="muted">月あたり上限（任意）</span>
          <input
            type="number"
            min={0}
            placeholder="未設定"
            value={spend.maxPerMonthJpy ?? ""}
            onChange={(e) =>
              patchSpend({
                maxPerMonthJpy:
                  e.target.value === "" ? null : Number(e.target.value) || 0,
              })
            }
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div>
        <div className="text-sm muted mb-2">買ってよいもののヒント（任意）</div>
        <div className="flex flex-wrap gap-2 mb-2">
          {MERCHANT_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`chip ${spend.merchantAllowTip === chip ? "chip-ok" : ""}`}
              onClick={() =>
                patchSpend({
                  merchantAllowTip: chip === "指定なし" ? null : chip,
                })
              }
            >
              {chip}
            </button>
          ))}
        </div>
        <input
          value={spend.merchantAllowTip ?? ""}
          onChange={(e) =>
            patchSpend({ merchantAllowTip: e.target.value || null })
          }
          placeholder="例: 海外渡航用 eSIM のみ"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
        />
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={spend.firstOrderRequiresHuman !== false}
          onChange={(e) =>
            patchSpend({ firstOrderRequiresHuman: e.target.checked })
          }
        />
        <span>
          <span className="font-medium">初回発注は必ず人間承認</span>
          <span className="block text-xs muted mt-0.5">
            おすすめ ON。初めての買い物は社長が一度目を通します。
          </span>
        </span>
      </label>
    </div>
  );
}


function BrowserAccountsSection({
  browserAllowed,
  setBrowserAllowed,
  allowedAccounts,
  setAllowedAccounts,
}: {
  browserAllowed: boolean;
  setBrowserAllowed: (on: boolean) => void;
  allowedAccounts: AllowedAccount[];
  setAllowedAccounts: (rows: AllowedAccount[]) => void;
}) {
  function patchRow(index: number, partial: Partial<AllowedAccount>) {
    setAllowedAccounts(
      allowedAccounts.map((row, i) => (i === index ? { ...row, ...partial } : row))
    );
  }

  function removeRow(index: number) {
    setAllowedAccounts(allowedAccounts.filter((_, i) => i !== index));
  }

  function addRow(service = "google") {
    setAllowedAccounts([...allowedAccounts, emptyAllowedAccount(service)]);
  }

  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">ブラウザ・外部アカウント</h3>
        <p className="mt-2 text-xs muted leading-relaxed">
          共有PCではログインが混ざる可能性があるため、使ってよいIDを社員証に刻みます。不一致時は要確認／停止。
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={browserAllowed}
          onChange={(e) => setBrowserAllowed(e.target.checked)}
        />
        <span>
          <span className="font-medium">ブラウザ利用を許可する</span>
          <span className="block text-xs muted mt-0.5">
            ON にすると「ブラウザ利用」が許可されます。共有のログインのまま個人のIDで動かさないでください。
          </span>
        </span>
      </label>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <span className="text-sm muted">許可する外部アカウント</span>
          <button
            type="button"
            className="chip text-[11px]"
            onClick={() => addRow(browserAllowed ? "google" : "google")}
          >
            ＋ 追加
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {ACCOUNT_SERVICE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="chip text-[11px]"
              onClick={() =>
                addRow(preset.key === "other" ? "" : preset.key)
              }
            >
              {preset.label}
            </button>
          ))}
        </div>

        {allowedAccounts.length === 0 ? (
          <p className="text-xs faint">
            まだありません。チップからサービスを選ぶか「追加」してください（Google以外のSNSもOK）。
          </p>
        ) : (
          <ul className="space-y-3">
            {allowedAccounts.map((row, index) => {
              const isOther =
                !ACCOUNT_SERVICE_PRESETS.some(
                  (p) => p.key === row.service && p.key !== "other"
                );
              return (
                <li
                  key={index}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 space-y-2"
                >
                  <div className="grid md:grid-cols-2 gap-2">
                    <label className="block text-xs">
                      <span className="muted">サービス</span>
                      <select
                        value={
                          ACCOUNT_SERVICE_PRESETS.some(
                            (p) => p.key === row.service && p.key !== "other"
                          )
                            ? row.service
                            : "other"
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "other") {
                            patchRow(index, {
                              service: row.service && isOther ? row.service : "",
                            });
                          } else {
                            patchRow(index, {
                              service: v,
                              browserRequired:
                                v === "google" || v === "microsoft365"
                                  ? true
                                  : row.browserRequired,
                            });
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                      >
                        {ACCOUNT_SERVICE_PRESETS.map((preset) => (
                          <option key={preset.key} value={preset.key}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {isOther ||
                    !ACCOUNT_SERVICE_PRESETS.some(
                      (p) => p.key === row.service && p.key !== "other"
                    ) ? (
                      <label className="block text-xs">
                        <span className="muted">サービス名（自由記入）</span>
                        <input
                          value={row.service}
                          onChange={(e) =>
                            patchRow(index, { service: e.target.value })
                          }
                          placeholder="例: Chatwork / Notion"
                          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                        />
                      </label>
                    ) : (
                      <label className="block text-xs">
                        <span className="muted">表示ラベル（任意）</span>
                        <input
                          value={row.label ?? ""}
                          onChange={(e) =>
                            patchRow(index, { label: e.target.value })
                          }
                          placeholder="例: 営業用Google"
                          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                        />
                      </label>
                    )}
                  </div>
                  <label className="block text-xs">
                    <span className="muted">アカウントID（メール / @handle / ページID）</span>
                    <input
                      value={row.accountId}
                      onChange={(e) =>
                        patchRow(index, { accountId: e.target.value })
                      }
                      placeholder="例: sales@company.co.jp / @brand_jp"
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-1.5 text-sm"
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={row.browserRequired === true}
                        onChange={(e) =>
                          patchRow(index, {
                            browserRequired: e.target.checked,
                          })
                        }
                      />
                      ブラウザ一致を重視
                    </label>
                    <button
                      type="button"
                      className="text-xs text-[var(--danger)]"
                      onClick={() => removeRow(index)}
                    >
                      削除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
