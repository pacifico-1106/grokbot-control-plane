"use client";

import { useState } from "react";
import { PURPOSE_CHIPS, purposeLabelJa } from "@/lib/employees/known-purposes";
import { addPurposes, parsePurposes } from "@/lib/employees/purposes";

export function PurposeChips({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const extras = value.filter((purpose) => !PURPOSE_CHIPS.includes(purpose as (typeof PURPOSE_CHIPS)[number]));

  function toggle(purpose: string) {
    if (disabled) return;
    onChange(
      value.includes(purpose) ? value.filter((item) => item !== purpose) : addPurposes(value, [purpose])
    );
  }

  function add() {
    if (disabled) return;
    const extra = parsePurposes(draft);
    if (!extra.length) return;
    onChange(addPurposes(value, extra));
    setDraft("");
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PURPOSE_CHIPS.map((purpose) => {
          const on = value.includes(purpose);
          return (
            <button
              key={purpose}
              type="button"
              onClick={() => toggle(purpose)}
              disabled={disabled}
              className={`chip ${on ? "chip-ok" : ""}`}
            >
              {purposeLabelJa(purpose)}
            </button>
          );
        })}
        {extras.map((purpose) => (
          <button
            key={purpose}
            type="button"
            onClick={() => toggle(purpose)}
            disabled={disabled}
            className="chip chip-ok"
          >
            {purposeLabelJa(purpose)}
          </button>
        ))}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="使う理由を追加"
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          disabled={disabled}
        />
        <button type="button" className="btn btn-ghost text-xs" disabled={disabled || !draft.trim()} onClick={add}>
          追加
        </button>
      </div>
    </div>
  );
}
