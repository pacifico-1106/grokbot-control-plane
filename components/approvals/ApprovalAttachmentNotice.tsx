import type { CardAttachment } from "@/lib/approvals/attachment-card";

/**
 * The approved attachment on the Web approval card (#253 follow-up 5).
 *
 * Its own element with its own label, fed only by `PublicApproval.cardAttachment`
 * (server-side snapshot: filename + size). It is rendered apart from the summary
 * so a "添付ファイル:" line the agent wrote inside the message body can never be
 * mistaken for it. React escapes the filename (plain text, no markup).
 */
export function ApprovalAttachmentNotice({ attachment }: { attachment: CardAttachment | null | undefined }) {
  if (!attachment) return null;
  return (
    <div
      data-approval-attachment="snapshot"
      className="mt-2 rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed"
    >
      <p className="font-medium">
        承認対象の添付ファイル
        <span className="ml-2 chip text-[10px]">システム記録</span>
      </p>
      {attachment.kind === "present" ? (
        (attachment.files && attachment.files.length > 0 ? attachment.files : [
          { filename: attachment.filename, bytes: attachment.bytes, sizeLabel: attachment.sizeLabel, mimeType: attachment.mimeType },
        ]).map((file, index) => {
          const meta = [file.mimeType, file.sizeLabel].filter(Boolean).join(", ");
          return (
            <p key={`${index}:${file.filename}`} className="mt-1 break-all">
              <span className="font-mono">{file.filename}</span>
              {meta ? <span className="ml-2 faint">（{meta}）</span> : null}
            </p>
          );
        })
      ) : (
        <p className="mt-1 muted">なし（この承認に添付ファイルは含まれません）</p>
      )}
      <p className="mt-1 faint text-[10px]">
        承認時に記録された内容です。本文中の「添付ファイル:」の記載とは別です。
      </p>
    </div>
  );
}
