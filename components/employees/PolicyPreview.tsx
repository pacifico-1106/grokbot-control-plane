"use client";

import { useMemo } from "react";
import { buildPolicyPreview } from "@/lib/employees/policy-preview";
import type {
  AllowedAccount,
  ApprovalPolicy,
  EmployeeScope,
  PostingAs,
  SodVerdict,
} from "@/lib/types";

const TONE_CHIP: Record<string, string> = {
  ok: "chip-ok",
  warn: "chip-warn",
  danger: "chip-danger",
  muted: "",
};

export function PolicyPreview({
  scopes,
  allowedPurposes,
  approvalPolicy,
  liveSod,
  allowedAccounts,
  postingAs,
  slackLinked,
  toolApprovalDefaults,
}: {
  scopes: EmployeeScope[];
  allowedPurposes?: string[];
  approvalPolicy: ApprovalPolicy;
  liveSod?: Pick<SodVerdict, "level" | "domains"> | null;
  allowedAccounts?: AllowedAccount[] | null;
  postingAs?: PostingAs | null;
  slackLinked?: boolean;
  toolApprovalDefaults?: Record<string, ApprovalPolicy | "deny"> | null;
}) {
  const rows = useMemo(
    () =>
      buildPolicyPreview({
        scopes,
        allowedPurposes,
        approvalPolicy,
        liveSod,
        allowedAccounts,
        postingAs,
        slackLinked,
        toolApprovalDefaults,
      }),
    [scopes, allowedPurposes, approvalPolicy, liveSod, allowedAccounts, postingAs, slackLinked, toolApprovalDefaults]
  );
  const danger = rows.some((row) => row.tone === "danger");
  const warn = rows.some((row) => row.tone === "warn");

  return (
    <div
      className="rounded-xl border px-4 py-3 space-y-2"
      style={{
        borderColor: danger
          ? "color-mix(in oklab, var(--danger) 48%, var(--border))"
          : warn
            ? "color-mix(in oklab, var(--warn) 48%, var(--border))"
            : "var(--border-soft)",
        background: danger
          ? "color-mix(in oklab, var(--danger) 7%, var(--bg-soft))"
          : warn
            ? "color-mix(in oklab, var(--warn) 7%, var(--bg-soft))"
            : "var(--bg-soft)",
      }}
    >
      <p className="text-sm font-medium">この設定だと:</p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="muted">{row.label}</span>
            <span className={`chip text-[11px] ${TONE_CHIP[row.tone] ?? ""}`}>{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
