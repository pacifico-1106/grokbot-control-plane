"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APPROVAL_POLICY_LABELS,
  SCOPE_LABELS,
} from "@/lib/employees/policy-draft";
import { parsePurposes } from "@/lib/employees/purposes";
import { evaluateSod } from "@/lib/employees/sod";
import type { ApprovalPolicy, Employee, EmployeeScope } from "@/lib/types";

export function EmployeePolicyForm({
  employee,
  disabled = false,
}: {
  employee: Employee;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [scopes, setScopes] = useState<EmployeeScope[]>(employee.scopes ?? []);
  const [purposes, setPurposes] = useState(
    (employee.allowedPurposes ?? []).join(", ")
  );
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    employee.approvalPolicy
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const liveSod = useMemo(() => evaluateSod(scopes), [scopes]);
  const forceHuman = liveSod.level === "force_human";
  const effectiveApproval: ApprovalPolicy = forceHuman
    ? "always_human"
    : approvalPolicy;
  const locked = busy || disabled;
  const canSave = scopes.length > 0 && !locked;

  function toggleScope(scope: EmployeeScope) {
    if (locked) return;
    setScopes((cur) =>
      cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]
    );
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
          allowedPurposes: parsePurposes(purposes),
          approvalPolicy: effectiveApproval,
          actionLimits: employee.actionLimits,
          managerId: employee.managerId ?? null,
          voice: employee.voice,
          projectAccess: employee.projectAccess,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      if (Array.isArray(body.employee?.scopes)) {
        setScopes(body.employee.scopes as EmployeeScope[]);
      }
      if (Array.isArray(body.employee?.allowedPurposes)) {
        setPurposes(body.employee.allowedPurposes.join(", "));
      }
      if (typeof body.employee?.approvalPolicy === "string") {
        setApprovalPolicy(body.employee.approvalPolicy as ApprovalPolicy);
      }
      setMessage("権限を保存しました");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
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

      <label className="block text-sm">
        <span className="muted">許可目的（カンマ区切り）</span>
        <input
          value={purposes}
          onChange={(e) => setPurposes(e.target.value)}
          placeholder="ops.admin, sales.outreach, calendar.propose, comm.internal"
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          disabled={locked}
        />
      </label>

      {forceHuman ? (
        <div
          className="rounded-xl border p-3 border-[color-mix(in_oklab,var(--danger)_48%,var(--border))]"
          role="alert"
        >
          <p className="text-sm leading-relaxed muted">
            複数の高リスク領域を持つため、このまま発行すると全行為が人の承認必須になります。分けると下書きや提案を自動化できます。
          </p>
        </div>
      ) : null}

      <label className="block text-sm">
        <span className="muted">承認ポリシー</span>
        <select
          value={effectiveApproval}
          disabled={locked || forceHuman}
          onChange={(e) =>
            setApprovalPolicy(e.target.value as ApprovalPolicy)
          }
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
        >
          {(Object.keys(APPROVAL_POLICY_LABELS) as ApprovalPolicy[]).map(
            (key) => (
              <option key={key} value={key}>
                {APPROVAL_POLICY_LABELS[key]}
              </option>
            )
          )}
        </select>
      </label>

      <p className="text-xs muted leading-relaxed">
        mail.send / commerce.order などの確定操作は Gateway 側でも人が止める。社員レベルを always_human にしなくてもツール側 force は残る。
      </p>

      <button
        type="button"
        className="btn btn-primary text-xs"
        disabled={!canSave}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "権限を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
