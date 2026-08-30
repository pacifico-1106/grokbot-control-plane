"use client";

import {
  CHOOSABLE_TOOL_APPROVALS,
  CHOOSABLE_TOOL_LABELS,
  TOOL_APPROVAL_CHOICE_LABELS,
  choosableToolIsEnabled,
} from "@/lib/employees/approval-presets";
import type { ApprovalPolicy } from "@/lib/types";

const CHOICES: ApprovalPolicy[] = ["always_human", "risk_based", "auto"];

export function ToolApprovalHints({
  scopes,
  value,
  onChange,
  disabled = false,
}: {
  scopes: readonly string[];
  value: Record<string, ApprovalPolicy | "deny">;
  onChange: (next: Record<string, ApprovalPolicy | "deny">) => void;
  disabled?: boolean;
}) {
  const visible = CHOOSABLE_TOOL_APPROVALS.filter((tool) => choosableToolIsEnabled(tool, scopes));
  if (visible.length === 0) return null;

  function setTool(tool: (typeof CHOOSABLE_TOOL_APPROVALS)[number], next: ApprovalPolicy) {
    onChange({ ...value, [tool]: next });
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">人が見る行為</legend>
      <p className="text-xs muted leading-relaxed">
        初期値は毎回人が見ます。警告を承諾すれば自動にもできます。責任は事業者にあります。
      </p>
      {visible.map((tool) => {
        const current = value[tool] === "auto" || value[tool] === "risk_based" ? value[tool] : "always_human";
        return (
          <label key={tool} className="block text-sm">
            <span className="muted">{CHOOSABLE_TOOL_LABELS[tool]}</span>
            <select
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              value={current}
              disabled={disabled}
              onChange={(e) => setTool(tool, e.target.value as ApprovalPolicy)}
            >
              {CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {TOOL_APPROVAL_CHOICE_LABELS[choice]}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </fieldset>
  );
}
