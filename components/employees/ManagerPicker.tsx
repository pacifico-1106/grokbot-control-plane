"use client";

import type { OrgMember } from "@/lib/types";

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
  const active = members.filter((member) => member.status === "active");
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
        {active.map((member) => (
          <option key={member.id} value={member.id}>
            {member.displayName}（{member.email}）
          </option>
        ))}
      </select>
      <span className="mt-1 block text-[11px] faint">
        機密開示の承認依頼に上長IDを付けます。相手の判定とは別です。
      </span>
    </label>
  );
}
