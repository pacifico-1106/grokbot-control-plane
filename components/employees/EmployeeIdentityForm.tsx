"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Employee } from "@/lib/types";

export function EmployeeIdentityForm({
  employee,
  disabled = false,
}: {
  employee: Employee;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(employee.displayName);
  const [roleLabel, setRoleLabel] = useState(employee.roleLabel);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/employees/${employee.id}/policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopes: employee.scopes,
          allowedPurposes: employee.allowedPurposes,
          approvalPolicy: employee.approvalPolicy,
          actionLimits: employee.actionLimits,
          managerId: employee.managerId ?? null,
          voice: employee.voice,
          projectAccess: employee.projectAccess,
          displayName,
          roleLabel,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      if (typeof body.employee?.displayName === "string") {
        setDisplayName(body.employee.displayName);
      }
      if (typeof body.employee?.roleLabel === "string") {
        setRoleLabel(body.employee.roleLabel);
      }
      setMessage("表示名を保存しました");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const canSave = Boolean(displayName.trim() && roleLabel.trim());

  return (
    <div className="space-y-3">
      <div className="grid md:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="muted">表示名</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            maxLength={80}
            required
            disabled={busy || disabled}
          />
        </label>
        <label className="block text-sm">
          <span className="muted">職務ラベル</span>
          <input
            value={roleLabel}
            onChange={(e) => setRoleLabel(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            maxLength={80}
            required
            disabled={busy || disabled}
          />
        </label>
      </div>
      <p className="text-xs muted leading-relaxed">
        AI社員番号は変わりません。MCP の whoami もこの表示名を返します。
      </p>
      <button
        type="button"
        className="btn btn-primary text-xs"
        disabled={busy || disabled || !canSave}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "表示名を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
