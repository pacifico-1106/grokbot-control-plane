"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  emptyAllowedAccount,
  normalizeAllowedAccounts,
} from "@/lib/employees/allowed-accounts";
import {
  alwaysHumanMustList,
  denyDefaultList,
  normalizeToolApprovalDefaults,
} from "@/lib/employees/approval-presets";
import { BrowserAccountsSection } from "@/components/employees/BrowserAccountsSection";
import { ManagerPicker } from "@/components/employees/ManagerPicker";
import { ApprovalInboxPicker } from "@/components/employees/ApprovalInboxPicker";
import { SpendForm } from "@/components/employees/SpendForm";
import { VoiceForm } from "@/components/employees/VoiceForm";
import { ProjectAccessForm } from "@/components/employees/ProjectAccessForm";
import { PolicyPreview } from "@/components/employees/PolicyPreview";
import { PurposeChips } from "@/components/employees/PurposeChips";
import { ToolApprovalHints } from "@/components/employees/ToolApprovalHints";
import {
  APPROVAL_POLICY_LABELS,
  HIRE_APPROVAL_CHOICES,
  SCOPE_LABELS,
  jobTextImpliesCommerceOrder,
} from "@/lib/employees/policy-draft";
import { sanitizePurposes } from "@/lib/employees/purposes";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";
import { evaluateSod, isComboSodWarn, sodNeedsOperatorAck } from "@/lib/employees/sod";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { policyErrorMessage } from "@/lib/employees/policy-errors";
import { DOMAIN_LABELS, domainOfScope } from "@/lib/gateway/domains";
import type {
  ActionLimits,
  AllowedAccount,
  ApprovalPolicy,
  EmployeePolicyDraft,
  EmployeeScope,
  EmployeeProjectAccess,
  EmployeeVoice,
  OrgMember,
  OrgProject,
  PostingAs,
  SodWarnPolicy,
  NotificationChannel,
  SpendLimits,
} from "@/lib/types";

const EXAMPLES = [
  "秘書として、メールの下書きと社内Slackの返信、日程の候補を出してほしい。会議の確定は人がする",
  "営業として見積メールの下書きを作り、送信前に必ず承認してほしい",
  "事務として請求書を確認し、社内ファイルを読むだけ",
  "購買で発注まで行うが、毎回人間の承認が必要",
  "個人SNSとして、X・note・LinkedIn・YouTubeへの投稿は毎回人が見てから出す",
];

type Step = "describe" | "draft" | "spend" | "issued";

function emptySpend(): SpendLimits {
  return { ...DEFAULT_SPEND_LIMITS };
}

export function HireEmployeeClient({
  members = [],
  projects = [],
  sodWarnPolicy = null,
  notificationChannels = [],
}: {
  members?: OrgMember[];
  projects?: OrgProject[];
  sodWarnPolicy?: SodWarnPolicy | null;
  notificationChannels?: NotificationChannel[];
}) {
  const [step, setStep] = useState<Step>("describe");
  const [managerId, setManagerId] = useState<string | null>(null);
  const [approvalChannelId, setApprovalChannelId] = useState<string | null>(null);
  const [approverUserIds, setApproverUserIds] = useState("");
  const [voice, setVoice] = useState<EmployeeVoice>(defaultVoice());
  const [projectAccess, setProjectAccess] = useState<EmployeeProjectAccess>(defaultProjectAccess());
  const [postingAs, setPostingAs] = useState<PostingAs>("bot");
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<EmployeePolicyDraft | null>(null);
  const [drafts, setDrafts] = useState<EmployeePolicyDraft[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [scopes, setScopes] = useState<EmployeeScope[]>([]);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [approvalPolicy, setApprovalPolicy] =
    useState<ApprovalPolicy>("risk_based");
  const [actionLimits, setActionLimits] = useState<ActionLimits>({});
  const [sodOverrideAcknowledged, setSodOverrideAcknowledged] = useState(false);
  const [toolApprovalDefaults, setToolApprovalDefaults] = useState(() =>
    normalizeToolApprovalDefaults(undefined)
  );
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [spend, setSpend] = useState<SpendLimits>(emptySpend);
  const [futureSpendOpen, setFutureSpendOpen] = useState(false);
  const [browserAllowed, setBrowserAllowed] = useState(false);
  const [allowedAccounts, setAllowedAccounts] = useState<AllowedAccount[]>([]);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);
  const [orderInferredFromJob, setOrderInferredFromJob] = useState(false);
  const [issuedEmployeeId, setIssuedEmployeeId] = useState<string | null>(null);
  const [issuedBatch, setIssuedBatch] = useState<Array<{
    id: string;
    displayName: string;
    oneTimeSecret: string;
  }>>([]);
  const [copied, setCopied] = useState(false);
  const [hirePack, setHirePack] = useState<{
    instructionsSnippet: string;
    routineText: string;
    noticeJa?: string;
  } | null>(null);
  const [copiedPack, setCopiedPack] = useState<"instructions" | "routine" | null>(
    null
  );

  const purposeList = purposes;

  const hasOrderScope = scopes.includes("commerce:order");
  const liveSod = useMemo(() => evaluateSod(scopes, sodWarnPolicy), [scopes, sodWarnPolicy]);
  const comboWarn = isComboSodWarn(liveSod);
  const needsSodAck = sodNeedsOperatorAck(liveSod) && approvalPolicy !== "always_human";

  function applyDraft(d: EmployeePolicyDraft) {
    setDraft(d);
    setDisplayName(d.policy.displayName);
    setRoleLabel(d.policy.roleLabel);
    const inferredOrder =
      d.policy.scopes.includes("commerce:order") &&
      (jobTextImpliesCommerceOrder(prompt) || d.warnings.includes("commerce_order_requested"));
    const scopesUnique = [...new Set(d.policy.scopes)] as EmployeeScope[];
    setOrderInferredFromJob(inferredOrder);
    setScopes(scopesUnique);
    setPurposes(sanitizePurposes(d.policy.allowedPurposes));
    setApprovalPolicy(d.policy.approvalPolicy);
    setActionLimits(d.policy.actionLimits || {});
    setToolApprovalDefaults(normalizeToolApprovalDefaults(d.policy.toolApprovalDefaults));
    setSodOverrideAcknowledged(false);
    setExpiresInDays(d.policy.expiresInDays);
    setSpend(scopesUnique.includes("commerce:order")
      ? { ...DEFAULT_SPEND_LIMITS, ...(d.policy.spend ?? {}) }
      : emptySpend());
    setFutureSpendOpen(false);
    const hasBrowser = d.policy.scopes.includes("browser:use");
    setBrowserAllowed(hasBrowser);
    setAllowedAccounts(d.policy.allowedAccounts?.length
      ? d.policy.allowedAccounts.map((a) => ({ ...a }))
      : hasBrowser ? [emptyAllowedAccount("google")] : []);
    setVoice(d.policy.voice ? normalizeVoice(d.policy.voice) : defaultVoice());
    setProjectAccess(
      d.policy.projectAccess ? normalizeProjectAccess(d.policy.projectAccess) : defaultProjectAccess()
    );
  }

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
      if (!res.ok) throw new Error(policyErrorMessage(body, "職務の読み取りに失敗しました"));
      const nextDrafts = (Array.isArray(body.drafts) && body.drafts.length
        ? body.drafts
        : [body.draft]) as EmployeePolicyDraft[];
      setDrafts(nextDrafts);
      applyDraft(nextDrafts[0]);
      setStep("draft");
    } catch (e) {
      setError(e instanceof Error ? e.message : "職務の読み取りに失敗しました");
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
          actionLimits,
          toolApprovalDefaults,
          sodOverrideAcknowledged,
          expiresInDays,
          spend: hasOrderScope || futureSpendOpen ? spend : null,
          allowedAccounts: normalizeAllowedAccounts(allowedAccounts),
          managerId,
          voice,
          projectAccess,
          postingAs,
          approvalChannelId,
          approverUserIds,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(policyErrorMessage(body, "社員証の発行に失敗しました"));
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
      setError(e instanceof Error ? e.message : "社員証の発行に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function issueSplitDrafts() {
    if (drafts.length < 2) return;
    setLoading(true);
    setError("");
    try {
      const issued: Array<{ id: string; displayName: string; oneTimeSecret: string }> = [];
      for (const item of drafts) {
        const res = await fetch("/api/employees/issue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...item.policy,
            jobDescription: `${prompt}（職務分離: ${item.policy.roleLabel}）`,
            spend: item.policy.spend ?? null,
            allowedAccounts: item.policy.allowedAccounts ?? [],
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(policyErrorMessage(body, "社員証の発行に失敗しました"));
        issued.push({
          id: body.employee.id,
          displayName: body.employee.displayName,
          oneTimeSecret: body.credential.oneTimeSecret,
        });
      }
      setIssuedBatch(issued);
      setIssuedEmployeeId(issued[0]?.id ?? null);
      setOneTimeSecret(issued[0]?.oneTimeSecret ?? null);
      setStep("issued");
    } catch (e) {
      setError(e instanceof Error ? e.message : "社員証の発行に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  function splitCurrentPermissions() {
    if (!draft) return;
    const risky = [...new Set(scopes.map(domainOfScope).filter((domain) => domain !== "safe"))];
    if (risky.length < 2) return;
    const safe = scopes.filter((scope) => domainOfScope(scope) === "safe");
    const split = risky.map((domain) => {
      const splitScopes = [...new Set([...safe, ...scopes.filter((scope) => domainOfScope(scope) === domain)])];
      return {
        ...draft,
        policy: {
          ...draft.policy,
          displayName: `${displayName}（${DOMAIN_LABELS[domain]}）`,
          roleLabel: `${roleLabel}・${DOMAIN_LABELS[domain]}`,
          scopes: splitScopes,
          approvalPolicy: "risk_based" as ApprovalPolicy,
        },
        sodVerdict: evaluateSod(splitScopes),
      };
    });
    setDrafts(split);
    applyDraft(split[0]);
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

          {drafts.length > 1 ? (
            <div className="rounded-xl border border-[color-mix(in_oklab,var(--ok)_42%,var(--border))] bg-[color-mix(in_oklab,var(--ok)_7%,var(--bg-soft))] p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{drafts.length}人に分ける案を作りました</p>
                  <p className="mt-1 text-xs muted">権限をまとめず、職務ごとに最小限の社員証を発行します。</p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary text-xs shrink-0"
                  disabled={loading}
                  onClick={() => void issueSplitDrafts()}
                >
                  {loading ? "発行中…" : `${drafts.length}人の社員として雇う（推奨）`}
                </button>
              </div>
              <div className="mt-3 grid sm:grid-cols-2 gap-2">
                {drafts.map((item, index) => (
                  <button
                    type="button"
                    key={`${item.policy.roleLabel}-${index}`}
                    className="text-left rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 hover:border-[var(--text-faint)]"
                    onClick={() => applyDraft(item)}
                  >
                    <span className="text-sm font-medium">{item.policy.displayName}</span>
                    <span className="block mt-1 text-xs muted">{item.policy.roleLabel} · {item.policy.scopes.length}権限</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {liveSod.level !== "ok" ? (
            <div
              className="rounded-xl border p-4 border-[color-mix(in_oklab,var(--warn)_48%,var(--border))]"
              role="alert"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip chip-warn">
                  {comboWarn ? "危ない組み合わせ" : "ブラウザ権限に注意"}
                </span>
                <span className="text-xs muted">
                  {liveSod.domains.map((domain) => DOMAIN_LABELS[domain]).join(" / ")}
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed muted">
                {comboWarn
                  ? sodOverrideAcknowledged
                    ? "警告を確認しました。責任は事業者にあります。警告と承諾だけで、行為は止めません。完全自動化できます。"
                    : "高リスク権限を同時に持たせています。発行には警告の承諾が必要です。責任は事業者にあります。"
                  : "ブラウザ操作は共有セッションで動きます。利用できるアカウントを次の画面で必ず限定してください。"}
              </p>
              {comboWarn ? (
                <div className="mt-3 flex flex-col sm:flex-row gap-2">
                  <button type="button" className="btn btn-primary text-xs" onClick={splitCurrentPermissions}>
                    権限を分ける（推奨）
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    onClick={() => {
                      setSodOverrideAcknowledged(true);
                    }}
                  >
                    {sodOverrideAcknowledged ? "警告を確認済み" : "このまま発行する"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

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

          <div>
            <h3 className="text-sm font-medium">何をする人？</h3>
            <p className="mt-1 mb-2 text-xs muted">やらせること</p>
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

          <div>
            <h3 className="text-sm font-medium">何のために？</h3>
            <p className="mt-1 mb-2 text-xs muted">使う理由</p>
            <PurposeChips value={purposes} onChange={setPurposes} />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">一人でやっていいか？</legend>
            {HIRE_APPROVAL_CHOICES.map((choice) => (
              <label key={choice.value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="hire-approval-policy"
                  className="mt-1"
                  checked={approvalPolicy === choice.value}
                  onChange={() => setApprovalPolicy(choice.value)}
                />
                <span>
                  <span className="font-medium">{choice.label}</span>
                  <span className="block text-xs muted mt-0.5">{choice.hint}</span>
                </span>
              </label>
            ))}
            {needsSodAck && !sodOverrideAcknowledged ? (
              <span className="block text-xs text-[var(--warn)]">
                警告を確認してから進めます。責任は事業者にあります。
              </span>
            ) : null}
          </fieldset>


          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Slack 投稿名義</legend>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="hire-posting-as"
                className="mt-1"
                checked={postingAs === "bot"}
                onChange={() => setPostingAs("bot")}
              />
              <span>
                <span className="font-medium">会社のBotとして出す</span>
                <span className="block text-xs muted mt-0.5">設定の「チャンネルに書き込む」の Bot token を使います。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="hire-posting-as"
                className="mt-1"
                checked={postingAs === "user"}
                onChange={() => setPostingAs("user")}
              />
              <span>
                <span className="font-medium">この人として出す</span>
                <span className="block text-xs muted mt-0.5">発行後、社員証で Slack 連携します。未連携なら本人としては出せません。</span>
              </span>
            </label>
          </fieldset>

          <ToolApprovalHints
            scopes={scopes}
            value={toolApprovalDefaults}
            onChange={setToolApprovalDefaults}
          />

          <PolicyPreview
            scopes={scopes}
            allowedPurposes={purposes}
            approvalPolicy={approvalPolicy}
            liveSod={liveSod}
            allowedAccounts={allowedAccounts}
            postingAs={postingAs}
            slackLinked={false}
            toolApprovalDefaults={toolApprovalDefaults}
            sodWarnPolicy={sodWarnPolicy}
          />

          <ManagerPicker members={members} value={managerId} onChange={setManagerId} />
          <ApprovalInboxPicker
            channels={notificationChannels}
            approvalChannelId={approvalChannelId}
            onChannelChange={setApprovalChannelId}
            approverUserIds={approverUserIds}
            onApproverUserIdsChange={setApproverUserIds}
          />

          <ProjectAccessForm value={projectAccess} projects={projects} onChange={setProjectAccess} />

          <VoiceForm value={voice} onChange={setVoice} />

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

          {Object.keys(actionLimits).length ? (
            <details className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium">行為上限（推奨値）</summary>
              <div className="mt-3 grid sm:grid-cols-2 gap-2">
                {Object.entries(actionLimits).map(([tool, limit]) => (
                  <div key={tool} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs">
                    <span className="font-mono">{tool}</span>
                    <span className="muted ml-2">
                      {limit.perDay ? `1日 ${limit.perDay}回` : ""}
                      {limit.perDay && limit.perMonth ? " / " : ""}
                      {limit.perMonth ? `月 ${limit.perMonth}回` : ""}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] faint">到達後は承認が必要になり、2倍で安全停止します。</p>
            </details>
          ) : null}

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
            disabled={loading || (needsSodAck && !sodOverrideAcknowledged)}
            onClick={goToSpendOrIssue}
          >
            {needsSodAck && !sodOverrideAcknowledged
              ? "上の発行方法を選んでください"
              : "次へ：予算・承認の補足"}
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


          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Slack 投稿名義</legend>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="hire-posting-as"
                className="mt-1"
                checked={postingAs === "bot"}
                onChange={() => setPostingAs("bot")}
              />
              <span>
                <span className="font-medium">会社のBotとして出す</span>
                <span className="block text-xs muted mt-0.5">設定の「チャンネルに書き込む」の Bot token を使います。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="hire-posting-as"
                className="mt-1"
                checked={postingAs === "user"}
                onChange={() => setPostingAs("user")}
              />
              <span>
                <span className="font-medium">この人として出す</span>
                <span className="block text-xs muted mt-0.5">発行後、社員証で Slack 連携します。未連携なら本人としては出せません。</span>
              </span>
            </label>
          </fieldset>

          <ToolApprovalHints
            scopes={scopes}
            value={toolApprovalDefaults}
            onChange={setToolApprovalDefaults}
          />

          <PolicyPreview
            scopes={scopes}
            allowedPurposes={purposes}
            approvalPolicy={approvalPolicy}
            liveSod={liveSod}
            allowedAccounts={allowedAccounts}
            postingAs={postingAs}
            slackLinked={false}
            toolApprovalDefaults={toolApprovalDefaults}
            sodWarnPolicy={sodWarnPolicy}
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
          {issuedBatch.length > 1 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">職務を分けて {issuedBatch.length} 人を発行しました</p>
              {issuedBatch.map((item) => (
                <div key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">{item.displayName}</span>
                    <Link href={`/app/employees/${item.id}`} className="text-xs underline underline-offset-2">詳細</Link>
                  </div>
                  <code className="mt-2 block text-[11px] break-all text-[var(--warn)]">{item.oneTimeSecret}</code>
                </div>
              ))}
              <p className="text-[11px] text-[var(--warn)]">各接続用の鍵は、この画面でのみ確認できます。</p>
            </div>
          ) : null}
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
          {issuedBatch.length <= 1 ? <div className="rounded-xl border border-[var(--warn)]/40 bg-[var(--bg-soft)] p-4">
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
            <p className="mt-3 text-xs muted leading-relaxed">
              Grok Bot にはチャットへ貼らず、Plugins（リモート MCP）へ登録します。URL は{" "}
              <Link href="/app/integrations#mcp" className="underline underline-offset-2">
                連携
              </Link>
              。
            </p>
          </div> : null}
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
                setDrafts([]);
                setIssuedBatch([]);
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
