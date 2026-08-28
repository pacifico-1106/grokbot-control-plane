"use client";

import { useState } from "react";
import { ProjectAccessForm } from "@/components/employees/ProjectAccessForm";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import type { Employee, EmployeeProjectAccess, OrgProject } from "@/lib/types";
import { policyErrorMessage } from "@/lib/employees/policy-errors";

export function EmployeeProjectAccessForm({
  employee,
  projects,
  disabled = false,
}: {
  employee: Employee;
  projects: OrgProject[];
  disabled?: boolean;
}) {
  const [access, setAccess] = useState<EmployeeProjectAccess>(
    normalizeProjectAccess(employee.projectAccess ?? defaultProjectAccess())
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
          voice: employee.voice,
          projectAccess: access,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(policyErrorMessage(body));
      if (body.employee?.projectAccess) {
        setAccess(normalizeProjectAccess(body.employee.projectAccess));
      }
      setMessage("ナレッジ範囲を保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ProjectAccessForm
        value={access}
        projects={projects}
        onChange={setAccess}
        disabled={busy || disabled}
        name={`employee-project-access-${employee.id}`}
      />
      <button type="button" className="btn btn-primary text-xs" disabled={busy || disabled} onClick={() => void save()}>
        {busy ? "保存中…" : "ナレッジ範囲を保存"}
      </button>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </div>
  );
}
