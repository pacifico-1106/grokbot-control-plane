"use client";

import { useState } from "react";
import {
  LINE_COMM_LINK_HELP_JA,
  LINE_COMM_LINK_ISSUE_BUSY_JA,
  LINE_COMM_LINK_ISSUE_BUTTON_JA,
  LINE_COMM_LINK_ISSUE_FAIL_JA,
} from "@/lib/comm/line-poc-copy";

export function EmployeeLineLinkCodeForm({
  employeeId,
  canIssue,
  disabled,
}: {
  employeeId: string;
  canIssue: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [display, setDisplay] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");

  if (!canIssue) return null;

  async function issue() {
    setBusy(true);
    setMessage("");
    setDisplay("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/comm-link-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        display?: string;
        expiresAt?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.message || body.error || LINE_COMM_LINK_ISSUE_FAIL_JA);
      setDisplay(body.display || "");
      setExpiresAt(body.expiresAt || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : LINE_COMM_LINK_ISSUE_FAIL_JA);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs muted leading-relaxed">
        {LINE_COMM_LINK_HELP_JA}
      </p>
      <button
        type="button"
        className="text-xs underline underline-offset-2 min-h-[44px]"
        disabled={busy || disabled}
        onClick={() => void issue()}
      >
        {busy ? LINE_COMM_LINK_ISSUE_BUSY_JA : LINE_COMM_LINK_ISSUE_BUTTON_JA}
      </button>
      {display ? (
        <p className="text-sm font-mono">
          {display}
          {expiresAt ? <span className="ml-2 text-xs muted">有効期限 {new Date(expiresAt).toLocaleString("ja-JP")}</span> : null}
        </p>
      ) : null}
      {message ? <p className="text-xs text-[var(--danger)]">{message}</p> : null}
    </div>
  );
}
