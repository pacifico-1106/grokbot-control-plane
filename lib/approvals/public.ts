import { cardApprovalReasonsLine } from "@/lib/approvals/approval-reasons";
import type { ApprovalRequest } from "@/lib/types";
import {
  readCardAttachment,
  withoutAttachmentSummaryLine,
  type CardAttachment,
} from "@/lib/approvals/attachment-card";
import { redactMetadata } from "@/lib/data/redaction";

/**
 * Browser DTO. `cardAttachment` is computed here, on the server, from the
 * approval snapshot only (metadata.invoke.fileAttachment: filename + size), so
 * the Web card never derives "the attachment" from summary / body text.
 * null = nothing recorded (legacy record / tool without conversation attachments).
 */
export type PublicApproval = ApprovalRequest & {
  cardAttachment: CardAttachment | null;
  /** 木村 B: the same 「承認が必要な理由」 line as Slack / LINE / Telegram; null when APPROVAL_REASONS_ENABLED is OFF. */
  cardReasons: string | null;
};

/** Browser DTO only. Internal fulfillment retains its private execution inputs. */
export function publicApproval(approval: ApprovalRequest): PublicApproval {
  return {
    ...approval,
    summary: withoutAttachmentSummaryLine(approval.summary ?? "", approval.metadata),
    statusToken: "",
    pollPath: "",
    metadata: redactMetadata(approval.metadata) as Record<string, unknown>,
    cardAttachment: readCardAttachment(approval.metadata),
    cardReasons: cardApprovalReasonsLine(approval.metadata, approval.summary),
  };
}
