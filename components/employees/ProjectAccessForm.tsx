"use client";

import {
  PROJECT_ACCESS_HELPER_JA,
  PROJECT_ACCESS_MODE_LABELS_JA,
  defaultSelectedProjectIds,
} from "@/lib/employees/project-access";
import type { EmployeeProjectAccess, OrgProject, ProjectAccessMode } from "@/lib/types";

const MODES: ProjectAccessMode[] = ["company", "selected", "all"];

export function ProjectAccessForm({
  value,
  projects,
  onChange,
  disabled,
  name = "employee-project-access",
}: {
  value: EmployeeProjectAccess;
  projects: OrgProject[];
  onChange: (access: EmployeeProjectAccess) => void;
  disabled?: boolean;
  name?: string;
}) {
  const defaultProject = projects.find((item) => item.isDefault);

  function setMode(mode: ProjectAccessMode) {
    if (mode === "selected") {
      onChange({
        mode: "selected",
        projectIds: defaultSelectedProjectIds(defaultProject?.id || "", value),
      });
      return;
    }
    onChange({ mode, projectIds: [] });
  }

  function toggleProject(id: string) {
    const next = new Set(value.projectIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ mode: "selected", projectIds: [...next] });
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm muted">ナレッジ範囲</legend>
        <div className="flex flex-wrap gap-3">
          {MODES.map((mode) => (
            <label key={mode} className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={name}
                disabled={disabled}
                checked={value.mode === mode}
                onChange={() => setMode(mode)}
              />
              {PROJECT_ACCESS_MODE_LABELS_JA[mode]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs muted leading-relaxed">{PROJECT_ACCESS_HELPER_JA}</p>
      {value.mode === "selected" ? (
        <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-3 space-y-2">
          {projects.map((project) => (
            <label key={project.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value.projectIds.includes(project.id)}
                onChange={() => toggleProject(project.id)}
              />
              <span>
                {project.name}
                {project.isDefault ? (
                  <span className="chip chip-ok ml-2 text-[11px]">既定</span>
                ) : null}
              </span>
            </label>
          ))}
          {!projects.length ? (
            <p className="text-xs muted">プロジェクトがまだありません。設定で追加できます。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
