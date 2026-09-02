"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrowserAccountsSection } from "@/components/employees/BrowserAccountsSection";
import { SpendForm } from "@/components/employees/SpendForm";
import { emptyAllowedAccount, normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { PolicyPreview } from "@/components/employees/PolicyPreview";
import { PurposeChips } from "@/components/employees/PurposeChips";
import { ToolApprovalHints } from "@/components/employees/ToolApprovalHints";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import {
  HIRE_APPROVAL_CHOICES,
  SCOPE_LABELS,
} from "@/lib/employees/policy-draft";
import { evaluateSod, isComboSodWarn, sodNeedsOperatorAck } from "@/lib/employees/sod";
import { policyErrorMessage } from "@/lib/employees/policy-errors";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";
import type {
  ActionLimits,
  AllowedAccount,
  ApprovalPolicy,
  Employee,
  EmployeeScope,
  SodWarnPolicy,
  SpendLimits,
} from "@/lib/types";

function emptySpend(): SpendLimits {
  return { ...DEFAULT_SPEND_LIMITS };
}

export function EmployeePolicyForm({
  employee,
  slackLinked = false,
  disabled = false,
  readOnly = false,
  sodWarnPolicy = null,
}: {
  employee: Employee;
  slackLinked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  sodWarnPolicy?: SodWarnPolicy | null;
}) {
  const router = useRouter();
  const [scopes, setScopes] = useState<EmployeeScope[]>(employee.scopes ?? []);
  const [purposeList, setPurposeList] = useState<string[]>(employee.allowedPurposes ?? []);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    employee.approvalPolicy
  );
  const [actionLimits, setActionLimits] = useState<ActionLimits>(employee.actionLimits ?? {});
  const [spend, setSpend] = useState<SpendLimits | null>(
    (employee.scopes ?? []).includes("commerce:order")
      ? { ...DEFAULT_SPEND_LIMITS, ...(employee.spend ?? {}) }
      : null
  );
  const [browserAllowed, setBrowserAllowed] = useState(
    (employee.scopes ?? []).includes("browser:use")
  );
  const [allowedAccounts, setAllowedAccounts] = useState<AllowedAccount[]>(
    (employee.allowedAccounts ?? []).map((row) => ({ ...row }))
  );
  const [toolApprovalDefaults, setToolApprovalDefaults] = useState(
    () => normalizeToolApprovalDefaults(employee.toolApprovalDefaults)
  );
  const [sodAck, setSodAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const liveSod = useMemo(() => evaluateSod(scopes, sodWarnPolicy), [scopes, sodWarnPolicy]);
  const comboWarn = isComboSodWarn(liveSod);
  const ackNeeded = sodNeedsOperatorAck(liveSod) && approvalPolicy !== "always_human";
  const locked = busy || disabled || readOnly;
  const hasOrderScope = scopes.includes("commerce:order");
  const normalizedAccounts = normalizeAllowedAccounts(allowedAccounts);
  const browserNeedsAccounts =
    scopes.includes("browser:use") && normalizedAccounts.length === 0;
  const canSave =
    scopes.length > 0 && !locked && !(ackNeeded && !sodAck) && !browserNeedsAccounts;

  function toggleScope(scope: EmployeeScope) {
    if (locked) return;
    const next = scopes.includes(scope)
      ? scopes.filter((s) => s !== scope)
      : [...scopes, scope];
    setScopes(next);
    const orderOn = next.includes("commerce:order");
    const browserOn = next.includes("browser:use");
    setBrowserAllowed(browserOn);
    if (orderOn) {
      setSpend((current) => current ?? emptySpend());
    } else {
      setSpend(null);
    }
    if (browserOn) {
      setAllowedAccounts((rows) =>
        rows.length === 0 ? [emptyAllowedAccount("google")] : rows
      );
    }
  }

  function patchSpend(partial: Partial<SpendLimits>) {
    setSpend((current) => ({ ...(current ?? emptySpend()), ...partial }));
  }

  function patchActionLimit(tool: string, field: "perDay" | "perMonth", raw: string) {
    setActionLimits((current) => {
      const prev = current[tool] ?? {};
      const next = { ...prev };
      if (raw === "") {
        delete next[field];
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) next[field] = Math.floor(n);
        else delete next[field];
      }
      return { ...current, [tool]: next };
    });
  }

  function applyBrowserAllowed(on: boolean) {
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
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/employees/${employee.id}/policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopes,
          allowedPurposes: purposeList,
          approvalPolicy,
          toolApprovalDefaults,
          sodOverrideAcknowledged: ackNeeded ? true : false,
          actionLimits,
          spend: hasOrderScope ? spend : null,
          allowedAccounts: normalizedAccounts,
          managerId: employee.managerId ?? null,
          voice: employee.voice,
          projectAccess: employee.projectAccess,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(policyErrorMessage(body));
      }
      if (Array.isArray(body.employee?.scopes)) {
        const nextScopes = body.employee.scopes as EmployeeScope[];
        setScopes(nextScopes);
        setBrowserAllowed(nextScopes.includes("browser:use"));
      }
      if (Array.isArray(body.employee?.allowedPurposes)) {
        setPurposeList(body.employee.allowedPurposes as string[]);
      }
      if (typeof body.employee?.approvalPolicy === "string") {
        setApprovalPolicy(body.employee.approvalPolicy as ApprovalPolicy);
      }
      if (body.employee?.toolApprovalDefaults && typeof body.employee.toolApprovalDefaults === "object") {
        setToolApprovalDefaults(normalizeToolApprovalDefaults(body.employee.toolApprovalDefaults));
      }
      if (body.employee?.actionLimits && typeof body.employee.actionLimits === "object") {
        setActionLimits(body.employee.actionLimits as ActionLimits);
      }
      if (body.employee && "spend" in body.employee) {
        const nextSpend = body.employee.spend as SpendLimits | null;
        setSpend(
          (body.employee.scopes as EmployeeScope[] | undefined)?.includes("commerce:order")
            ? { ...DEFAULT_SPEND_LIMITS, ...(nextSpend ?? {}) }
            : null
        );
      }
      if (Array.isArray(body.employee?.allowedAccounts)) {
        setAllowedAccounts(
          (body.employee.allowedAccounts as AllowedAccount[]).map((row) => ({ ...row }))
        );
      }
      setSodAck(false);
      setMessage("権限を保存しました");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const actionLimitKeys = Object.keys(actionLimits);

  return (
    <div className="space-y-3">
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
                disabled={locked}
                className={`chip ${on ? "chip-ok" : ""}`}
              >
                {SCOPE_LABELS[scope]}
              </button>
            );
          })}
        </div>
        {scopes.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--warn)]">少なくとも1つの権限が必要です</p>
        ) : null}
      </div>

      <div>
        <h3 className="text-sm font-medium">何のために？</h3>
        <p className="mt-1 mb-2 text-xs muted">使う理由</p>
        <PurposeChips value={purposeList} onChange={setPurposeList} disabled={locked} />
      </div>

      <details className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium">行為上限</summary>
        {actionLimitKeys.length === 0 ? (
          <p className="mt-3 text-xs muted">未設定</p>
        ) : (
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {actionLimitKeys.map((tool) => {
              const limit = actionLimits[tool] ?? {};
              return (
                <div
                  key={tool}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs space-y-2"
                >
                  <span className="font-mono">{tool}</span>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="muted">1日</span>
                      <input
                        type="number"
                        min={0}
                        placeholder="未設定"
                        value={limit.perDay ?? ""}
                        onChange={(e) => patchActionLimit(tool, "perDay", e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
                        disabled={locked}
                      />
                    </label>
                    <label className="block">
                      <span className="muted">月</span>
                      <input
                        type="number"
                        min={0}
                        placeholder="未設定"
                        value={limit.perMonth ?? ""}
                        onChange={(e) => patchActionLimit(tool, "perMonth", e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
                        disabled={locked}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] faint">到達後は承認が必要になり、2倍で安全停止します。</p>
      </details>

      {hasOrderScope && spend ? (
        <div className="rounded-lg border border-[var(--border-soft)] p-4">
          <h3 className="text-sm font-medium mb-3">予算・承認（発注）</h3>
          <SpendForm
            approvalPolicy={approvalPolicy}
            setApprovalPolicy={setApprovalPolicy}
            spend={spend}
            patchSpend={patchSpend}
            disabled={locked}
          />
        </div>
      ) : null}

      <BrowserAccountsSection
        browserAllowed={browserAllowed}
        setBrowserAllowed={applyBrowserAllowed}
        allowedAccounts={allowedAccounts}
        setAllowedAccounts={setAllowedAccounts}
        disabled={locked}
      />
      {browserNeedsAccounts ? (
        <p className="text-xs text-[var(--warn)]">
          ブラウザ利用にはアカウントIDの登録が必要です
        </p>
      ) : null}

      {comboWarn ? (
        <div
          className="rounded-xl border p-3 border-[color-mix(in_oklab,var(--warn)_48%,var(--border))]"
          role="alert"
        >
          <p className="text-sm leading-relaxed muted">
            高リスク権限を同時に持たせています。保存には警告の承諾が必要です。責任は事業者にあります。
          </p>
          <p className="mt-2 text-xs leading-relaxed muted">
            警告と承諾だけで、行為は止めません。完全自動化できます。
          </p>
        </div>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">一人でやっていいか？</legend>
        {HIRE_APPROVAL_CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="employee-approval-policy"
              className="mt-1"
              checked={approvalPolicy === choice.value}
              disabled={locked}
              onChange={() => setApprovalPolicy(choice.value)}
            />
            <span>
              <span className="font-medium">{choice.label}</span>
              <span className="block text-xs muted mt-0.5">{choice.hint}</span>
            </span>
          </label>
        ))}
        {approvalPolicy === "auto" ? (
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" className="mt-1" checked readOnly disabled={locked} />
            <span>
              <span className="font-medium">低リスクのみ自動</span>
              <span className="block text-xs muted mt-0.5">保存済みの値です。上の二つから選べます。</span>
            </span>
          </label>
        ) : null}
      </fieldset>

      <ToolApprovalHints
        scopes={scopes}
        value={toolApprovalDefaults}
        onChange={setToolApprovalDefaults}
        disabled={locked}
      />

      <PolicyPreview
        scopes={scopes}
        allowedPurposes={purposeList}
        approvalPolicy={approvalPolicy}
        liveSod={liveSod}
        allowedAccounts={allowedAccounts}
        postingAs={employee.postingAs || "bot"}
        slackLinked={slackLinked}
        toolApprovalDefaults={toolApprovalDefaults}
        sodWarnPolicy={sodWarnPolicy}
      />

      {ackNeeded ? (
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={sodAck}
            disabled={locked}
            onChange={(e) => setSodAck(e.target.checked)}
          />
          <span>
            <span className="font-medium">警告を確認した。この権限のまま保存する</span>
            {!sodAck ? (
              <span className="block text-xs text-[var(--warn)] mt-0.5">
                確認しないと保存できません。責任は事業者にあります。
              </span>
            ) : null}
          </span>
        </label>
      ) : null}

      <p className="text-xs muted leading-relaxed">
        人が見る行為は下で選べます。責任は事業者にあります。
      </p>

      {readOnly ? (
        <p className="text-xs muted leading-relaxed">
          権限の変更は管理MCPの人承認です。この画面では編集できません。
        </p>
      ) : (
      <button
        type="button"
        className="btn btn-primary text-xs"
        disabled={!canSave}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "権限を保存"}
      </button>
      )}
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
