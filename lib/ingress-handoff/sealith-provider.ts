/**
 * Sealith Provider hook interface for encrypted file handoff.
 * Stub adapter that can be swapped for real Sealith crypto product integration.
 *
 * Provider flow:
 * 1. When effective rule has sealith=suggest|required and attachments present
 * 2. Call provider.requestTransfer() to initiate encrypted handoff
 * 3. Provider returns transferId for audit tracking
 * 4. If sealith=required and no transferId: fail-closed (no file body to wake)
 */

import type { SlackAttachment } from "./apply";
import type { SealithHandoffIntent } from "./resolve";

export type SealithTransferRequest = {
  orgId: string;
  employeeId?: string;
  jobId?: string;
  attachments: SlackAttachment[];
  intent: SealithHandoffIntent;
};

export type SealithTransferResult =
  | { ok: true; transferId: string; status: "initiated" | "pending" | "ready" }
  | { ok: false; error: string; code: SealithTransferErrorCode };

export type SealithTransferErrorCode =
  | "provider_unavailable"
  | "provider_timeout"
  | "invalid_attachment"
  | "encryption_failed"
  | "quota_exceeded"
  | "not_configured";

export interface SealithProvider {
  requestTransfer(request: SealithTransferRequest): Promise<SealithTransferResult>;
  getTransferStatus?(transferId: string): Promise<SealithTransferStatusResult>;
}

export type SealithTransferStatusResult =
  | { ok: true; transferId: string; status: "pending" | "ready" | "expired" | "failed" }
  | { ok: false; error: string };

let activeProvider: SealithProvider | null = null;

export function setSealithProvider(provider: SealithProvider | null): void {
  activeProvider = provider;
}

export function getSealithProvider(): SealithProvider | null {
  return activeProvider;
}

export const stubSealithProvider: SealithProvider = {
  async requestTransfer(request: SealithTransferRequest): Promise<SealithTransferResult> {
    if (!request.attachments.length) {
      return { ok: false, error: "No attachments provided", code: "invalid_attachment" };
    }
    const transferId = `sth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    console.info("sealith_stub_transfer_initiated", {
      transferId,
      orgId: request.orgId,
      employeeId: request.employeeId,
      jobId: request.jobId,
      attachmentCount: request.attachments.length,
      intent: request.intent,
    });
    return { ok: true, transferId, status: "initiated" };
  },
  async getTransferStatus(transferId: string): Promise<SealithTransferStatusResult> {
    return { ok: true, transferId, status: "pending" };
  },
};

export function useSealithStubProvider(): void {
  setSealithProvider(stubSealithProvider);
}

export type SealithTransferContext = {
  orgId: string;
  employeeId?: string;
  jobId?: string;
  attachments: SlackAttachment[];
  intent: SealithHandoffIntent;
};

export type RequestSealithTransferResult = {
  transferId?: string;
  transferStatus?: "initiated" | "pending" | "ready" | "failed";
  transferResult?: SealithTransferResult;
  blocked: boolean;
};

/**
 * Request a Sealith transfer if the intent requires it.
 * Returns transferId for audit tracking, or blocked=true if required but failed.
 */
export async function requestSealithTransferIfNeeded(
  context: SealithTransferContext
): Promise<RequestSealithTransferResult> {
  const { intent, attachments } = context;

  if (intent.mode === "off" || !attachments.length) {
    return { blocked: false };
  }

  const provider = getSealithProvider();

  if (!provider) {
    if (intent.required) {
      return { blocked: true, transferStatus: "failed" };
    }
    return { blocked: false };
  }

  const result = await provider.requestTransfer({
    orgId: context.orgId,
    employeeId: context.employeeId,
    jobId: context.jobId,
    attachments,
    intent,
  });

  if (result.ok) {
    return {
      transferId: result.transferId,
      transferStatus: result.status,
      transferResult: result,
      blocked: false,
    };
  }

  if (intent.required) {
    return {
      transferStatus: "failed",
      transferResult: result,
      blocked: true,
    };
  }

  return {
    transferStatus: "failed",
    transferResult: result,
    blocked: false,
  };
}
