"use client";

import { inboxOptionLabel } from "@/lib/employees/approval-inbox";
import type { NotificationChannel } from "@/lib/types";

export function ApprovalInboxPicker({
  channels,
  approvalChannelId,
  onChannelChange,
  approverUserIds,
  onApproverUserIdsChange,
  disabled = false,
}: {
  channels: NotificationChannel[];
  approvalChannelId: string | null;
  onChannelChange: (id: string | null) => void;
  approverUserIds: string;
  onApproverUserIdsChange: (value: string) => void;
  disabled?: boolean;
}) {
  const enabled = channels.filter((channel) => channel.enabled);
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">承認の届き先</legend>
      <p className="text-xs muted leading-relaxed">
        この社員の承認カードをどのインボックスに届けるか。未指定は組織の既定です。会話の書き込みとは別です。
      </p>
      {enabled.length === 0 ? (
        <p className="text-xs muted leading-relaxed">
          設定の「承認を受け取る」で先にインボックスを追加してください。
        </p>
      ) : (
        <label className="block text-xs muted">
          インボックス
          <select
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            value={approvalChannelId || ""}
            disabled={disabled}
            onChange={(event) => onChannelChange(event.target.value || null)}
          >
            <option value="">組織の既定インボックス</option>
            {enabled.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {inboxOptionLabel(channel)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-xs muted">
        この社員の承認者 user ID（任意・カンマ区切り）
        <input
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono"
          value={approverUserIds}
          disabled={disabled}
          onChange={(event) => onApproverUserIdsChange(event.target.value)}
          placeholder="空ならインボックスの許可 ID に従う"
        />
      </label>
    </fieldset>
  );
}
