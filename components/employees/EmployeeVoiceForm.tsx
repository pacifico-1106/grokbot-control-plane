"use client";

import { useState } from "react";
import { VoiceForm } from "@/components/employees/VoiceForm";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import type { Employee, EmployeeVoice } from "@/lib/types";
import { policyErrorMessage } from "@/lib/employees/policy-errors";

export function EmployeeVoiceForm({
  employee,
  disabled = false,
}: {
  employee: Employee;
  disabled?: boolean;
}) {
  const [voice, setVoice] = useState<EmployeeVoice>(
    normalizeVoice(employee.voice ?? defaultVoice())
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
          managerId: employee.managerId ?? null,
          voice,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(policyErrorMessage(body));
      if (body.employee?.voice) setVoice(normalizeVoice(body.employee.voice));
      setMessage("話し方を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <VoiceForm value={voice} onChange={setVoice} disabled={busy || disabled} />
      <button type="button" className="btn btn-primary text-xs" disabled={busy || disabled} onClick={() => void save()}>
        {busy ? "保存中…" : "話し方を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
