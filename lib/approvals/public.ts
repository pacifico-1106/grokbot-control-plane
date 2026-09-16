import type { ApprovalRequest } from "@/lib/types";
import { redactMetadata } from "@/lib/data/redaction";

/** Browser DTO only. Internal fulfillment retains its private execution inputs. */
export function publicApproval(approval: ApprovalRequest): ApprovalRequest {
  return {
    ...approval,
    statusToken: "",
    pollPath: "",
    metadata: redactMetadata(approval.metadata) as Record<string, unknown>,
  };
}
