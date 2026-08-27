"use client";

import { useState } from "react";
import { ManagerPicker } from "@/components/employees/ManagerPicker";
import type { Employee, OrgMember } from "@/lib/types";

export function EmployeeManagerForm({
  employee,
  members,
}: {
  employee: Employee;
  members: OrgMember[];
}) {
  const [managerId, setManagerId] = useState<string | null>(employee.managerId ?? null);
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
          managerId,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました");
      setMessage("上長を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ManagerPicker members={members} value={managerId} onChange={setManagerId} />
      <button type="button" className="btn btn-primary text-xs" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "上長を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
