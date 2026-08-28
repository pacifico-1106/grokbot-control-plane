"use client";

import type { OrgMember } from "@/lib/types";
import {
  managerOptionLabel,
  membersEligibleAsManager,
} from "@/lib/team/manager-candidates";

export function ManagerPicker({
  members,
  value,
  onChange,
  disabled,
}: {
  members: OrgMember[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const eligible = membersEligibleAsManager(members);
  return (
    <label className="block text-sm">
      <span className="muted">上長（承認チケットの宛先）</span>
      <select
        value={value || ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
      >
        <option value="">未設定</option>
        {eligible.map((member) => (
          <option key={member.id} value={member.id}>
            {managerOptionLabel(member)}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-[11px] faint">
        招待中のメンバーも上長にできます。承認チケットの宛先になります。ログインは不要です。
      </span>
    </label>
  );
}
