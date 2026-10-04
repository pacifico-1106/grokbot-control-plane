import type { ApprovalRequest } from "@/lib/types";
import type { CardAttachment } from "@/lib/approvals/attachment-card";
import { redactMetadata } from "@/lib/data/redaction";

/** STUB (tests first). */
export type PublicApproval = ApprovalRequest & { cardAttachment?: CardAttachment | null };

/** Browser DTO only. Internal fulfillment retains its private execution inputs. */
export function publicApproval(approval: ApprovalRequest): PublicApproval {
  return {
    ...approval,
    statusToken: "",
    pollPath: "",
    metadata: redactMetadata(approval.metadata) as Record<string, unknown>,
  };
}
