"use client";

import { useState } from "react";

export function CopyableValue({
  value,
  label = "コピー",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
      <code className="text-xs font-mono break-all rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-2 min-w-0 flex-1">
        {value}
      </code>
      <button
        type="button"
        className="btn btn-ghost text-xs min-h-[44px] w-full sm:w-auto shrink-0"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "コピーしました" : label}
      </button>
    </div>
  );
}
