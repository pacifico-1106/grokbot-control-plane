"use client";

import {
  CHOOSABLE_TOOL_APPROVALS,
  TOOL_APPROVAL_CHOICE_LABELS,
} from "@/lib/employees/approval-presets";
import type { ApprovalPolicy } from "@/lib/types";

const TOOL_LABELS: Record<(typeof CHOOSABLE_TOOL_APPROVALS)[number], string> = {
  "mail.send": "メール送信",
  "calendar.confirm": "予定の確定",
};

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
  const showSend = scopes.includes("mail:send") || scopes.includes("agentmail:send");
  const showConfirm = scopes.includes("calendar:confirm");
  if (!showSend && !showConfirm) return null;

  function setTool(tool: (typeof CHOOSABLE_TOOL_APPROVALS)[number], next: ApprovalPolicy) {
    onChange({ ...value, [tool]: next });
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">送信・確定を人が見るか</legend>
      <p className="text-xs muted leading-relaxed">
        初期値は毎回人が見ます。社員全体がリスクベースでも、ここを変えなければ送信と確定は止まります。
      </p>
      {CHOOSABLE_TOOL_APPROVALS.map((tool) => {
        if (tool === "mail.send" && !showSend) return null;
        if (tool === "calendar.confirm" && !showConfirm) return null;
        const current = value[tool] === "auto" || value[tool] === "risk_based" ? value[tool] : "always_human";
        return (
          <label key={tool} className="block text-sm">
            <span className="muted">{TOOL_LABELS[tool]}</span>
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
