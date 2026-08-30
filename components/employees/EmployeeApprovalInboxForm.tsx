"use client";

import { useState } from "react";
import { ApprovalInboxPicker } from "@/components/employees/ApprovalInboxPicker";
import { policyErrorMessage } from "@/lib/employees/policy-errors";
import type { Employee, NotificationChannel } from "@/lib/types";

export function EmployeeApprovalInboxForm({
  employee,
  channels,
  disabled = false,
}: {
  employee: Employee;
  channels: NotificationChannel[];
  disabled?: boolean;
}) {
  const [approvalChannelId, setApprovalChannelId] = useState<string | null>(
    employee.approvalChannelId ?? null
  );
  const [approverUserIds, setApproverUserIds] = useState(
    (employee.approverUserIds ?? []).join(",")
  );
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
          approvalChannelId,
          approverUserIds,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(policyErrorMessage(body));
      setMessage("承認の届き先を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ApprovalInboxPicker
        channels={channels}
        approvalChannelId={approvalChannelId}
        onChannelChange={setApprovalChannelId}
        approverUserIds={approverUserIds}
        onApproverUserIdsChange={setApproverUserIds}
        disabled={disabled || busy}
      />
      <button
        type="button"
        className="btn btn-primary text-xs"
        disabled={busy || disabled}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "届き先を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
