"use client";

/**
 * Shared required-reason submit for hold release (employee / org / leave all
 * render HoldPanel). Empty or whitespace-only reason keeps the button disabled
 * and shows 理由を入力してください — a blank press used to do nothing.
 */
import { REQUIRED_REASON_HINT_JA, hasRequiredReason } from "@/lib/safety/required-reason";

export function RequiredReasonSubmit({
  reason,
  onReasonChange,
  placeholder,
  submitLabel,
  busy,
  onSubmit,
}: {
  reason: string;
  onReasonChange: (value: string) => void;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
}) {
  const ready = hasRequiredReason(reason);
  return (
    <>
      <input
        className="input w-full"
        placeholder={placeholder}
        value={reason}
        maxLength={500}
        onChange={(e) => onReasonChange(e.target.value)}
      />
      {!ready ? <p className="text-xs muted">{REQUIRED_REASON_HINT_JA}</p> : null}
      <button
        type="button"
        className="btn"
        disabled={busy || !hasRequiredReason(reason)}
        onClick={() => {
          if (busy || !hasRequiredReason(reason)) return;
          onSubmit();
        }}
      >
        {submitLabel}
      </button>
    </>
  );
}
