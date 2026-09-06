/**
 * Ingress handoff application.
 * Applies body and attachment modes to shape wake payload content.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { extractSealithIntent } from "./resolve";
import type {
  AttachmentApproval,
  AttachmentHandoff,
  BodyHandoff,
  IngressHandoffRule,
  SealithHandoff,
} from "@/lib/types";

export interface SlackAttachment {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url?: string;
  bytes?: Uint8Array | string;
}

export interface AttachmentMeta {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  redacted: true;
}

export interface IngressContent {
  text: string;
  attachments?: SlackAttachment[];
}

export interface AppliedIngressContent {
  text: string;
  attachments?: (SlackAttachment | AttachmentMeta)[];
  bodyMode: BodyHandoff;
  attachmentMode: AttachmentHandoff;
  bodyTruncated?: boolean;
  attachmentsRedacted?: boolean;
  attachmentsRemoved?: boolean;
  pendingManagerApproval?: boolean;
  sealithHandoff: SealithHandoff;
  sealithTransferId?: string;
}

export interface WakeMetadata {
  jobId?: string;
  sealithHandoff: SealithHandoff;
  sealithTransferId?: string;
  bodyMode: BodyHandoff;
  attachmentMode: AttachmentHandoff;
  attachmentApproval?: AttachmentApproval;
  pendingManagerApproval?: boolean;
  auditNote?: string;
}

export interface ApplyIngressOptions {
  orgId: string;
  employeeId?: string;
  jobId?: string;
  sealithTransferId?: string;
}

/**
 * Apply body mode to message text.
 */
export function applyBodyMode(
  text: string,
  mode: BodyHandoff,
  prefixChars?: number
): { text: string; truncated: boolean } {
  if (mode === "none") {
    return { text: "", truncated: text.length > 0 };
  }
  if (mode === "prefix" && prefixChars && prefixChars > 0) {
    if (text.length <= prefixChars) {
      return { text, truncated: false };
    }
    return {
      text: text.slice(0, prefixChars) + "…",
      truncated: true,
    };
  }
  return { text, truncated: false };
}

/**
 * Apply attachment mode to attachments array.
 */
export function applyAttachmentMode(
  attachments: SlackAttachment[] | undefined,
  mode: AttachmentHandoff
): {
  attachments: (SlackAttachment | AttachmentMeta)[] | undefined;
  redacted: boolean;
  removed: boolean;
} {
  if (!attachments || attachments.length === 0) {
    return { attachments: undefined, redacted: false, removed: false };
  }

  if (mode === "none") {
    return { attachments: undefined, redacted: false, removed: true };
  }

  if (mode === "meta") {
    return {
      attachments: attachments.map((att) => ({
        id: att.id,
        name: att.name,
        mimetype: att.mimetype,
        size: att.size,
        redacted: true as const,
      })),
      redacted: true,
      removed: false,
    };
  }

  return { attachments, redacted: false, removed: false };
}

/**
 * Apply ingress handoff rule to incoming message content.
 *
 * Handles:
 * - body mode: full | prefix (with bodyPrefixChars) | none
 * - attachment mode: file | meta | none
 * - attachmentApproval=manager: fail-closed (treat as none + audit note)
 * - sealith required without transfer id: do not pass file bodies
 *
 * @param rule - Resolved ingress handoff rule
 * @param content - Original message content
 * @param options - Context for audit and sealith
 * @returns Applied content with metadata
 */
export async function applyIngressHandoff(
  rule: IngressHandoffRule,
  content: IngressContent,
  options: ApplyIngressOptions
): Promise<AppliedIngressContent> {
  const { text: appliedText, truncated } = applyBodyMode(
    content.text,
    rule.body,
    rule.bodyPrefixChars
  );

  let effectiveAttachmentMode = rule.attachment;
  let pendingManagerApproval = false;
  let auditNote: string | undefined;

  if (
    rule.attachmentApproval === "manager" &&
    content.attachments?.length &&
    effectiveAttachmentMode !== "none"
  ) {
    effectiveAttachmentMode = "none";
    pendingManagerApproval = true;
    auditNote =
      "attachmentApproval=manager: fail-closed (file bodies not passed pending manager approval implementation)";

    await appendAuditEvent({
      orgId: options.orgId,
      employeeId: options.employeeId ?? null,
      credentialId: null,
      action: "admin.ingressHandoff",
      purpose: "ingress.attachment_gated",
      summary: "添付ファイル: manager承認待ち (fail-closed)",
      metadata: {
        jobId: options.jobId,
        attachmentMode: rule.attachment,
        attachmentApproval: rule.attachmentApproval,
        attachmentCount: content.attachments?.length ?? 0,
        failClosed: true,
        auditNote,
      },
    }).catch(() => undefined);
  }

  const sealithIntent = extractSealithIntent(rule);

  if (
    sealithIntent.required &&
    !options.sealithTransferId &&
    effectiveAttachmentMode === "file" &&
    content.attachments?.length
  ) {
    effectiveAttachmentMode = "meta";
    auditNote =
      "sealith=required but no sealithTransferId: file bodies not passed (fail-closed)";

    await appendAuditEvent({
      orgId: options.orgId,
      employeeId: options.employeeId ?? null,
      credentialId: null,
      action: "admin.ingressHandoff",
      purpose: "ingress.sealith_required",
      summary: "Sealith必須: 転送IDなし (fail-closed、メタ情報のみ)",
      metadata: {
        jobId: options.jobId,
        sealithMode: sealithIntent.mode,
        sealithHints: sealithIntent.hints,
        attachmentCount: content.attachments?.length ?? 0,
        failClosed: true,
        auditNote,
      },
    }).catch(() => undefined);
  }

  const {
    attachments: appliedAttachments,
    redacted,
    removed,
  } = applyAttachmentMode(content.attachments, effectiveAttachmentMode);

  return {
    text: appliedText,
    attachments: appliedAttachments,
    bodyMode: rule.body,
    attachmentMode: effectiveAttachmentMode,
    bodyTruncated: truncated || undefined,
    attachmentsRedacted: redacted || undefined,
    attachmentsRemoved: removed || undefined,
    pendingManagerApproval: pendingManagerApproval || undefined,
    sealithHandoff: sealithIntent.mode,
    sealithTransferId: options.sealithTransferId,
  };
}

/**
 * Build wake metadata for audit trail.
 */
export function buildWakeMetadata(
  rule: IngressHandoffRule,
  options: ApplyIngressOptions,
  pendingManagerApproval?: boolean,
  auditNote?: string
): WakeMetadata {
  const sealithIntent = extractSealithIntent(rule);

  return {
    jobId: options.jobId,
    sealithHandoff: sealithIntent.mode,
    sealithTransferId: options.sealithTransferId,
    bodyMode: rule.body,
    attachmentMode: rule.attachment,
    attachmentApproval: rule.attachmentApproval,
    pendingManagerApproval,
    auditNote,
  };
}

/**
 * Synchronous version for tests or when no audit logging needed.
 */
export function applyIngressHandoffSync(
  rule: IngressHandoffRule,
  content: IngressContent,
  sealithTransferId?: string
): Omit<AppliedIngressContent, "pendingManagerApproval"> & {
  pendingManagerApproval?: boolean;
} {
  const { text: appliedText, truncated } = applyBodyMode(
    content.text,
    rule.body,
    rule.bodyPrefixChars
  );

  let effectiveAttachmentMode = rule.attachment;
  let pendingManagerApproval = false;

  if (
    rule.attachmentApproval === "manager" &&
    content.attachments?.length &&
    effectiveAttachmentMode !== "none"
  ) {
    effectiveAttachmentMode = "none";
    pendingManagerApproval = true;
  }

  const sealithIntent = extractSealithIntent(rule);

  if (
    sealithIntent.required &&
    !sealithTransferId &&
    effectiveAttachmentMode === "file" &&
    content.attachments?.length
  ) {
    effectiveAttachmentMode = "meta";
  }

  const {
    attachments: appliedAttachments,
    redacted,
    removed,
  } = applyAttachmentMode(content.attachments, effectiveAttachmentMode);

  return {
    text: appliedText,
    attachments: appliedAttachments,
    bodyMode: rule.body,
    attachmentMode: effectiveAttachmentMode,
    bodyTruncated: truncated || undefined,
    attachmentsRedacted: redacted || undefined,
    attachmentsRemoved: removed || undefined,
    pendingManagerApproval: pendingManagerApproval || undefined,
    sealithHandoff: sealithIntent.mode,
    sealithTransferId,
  };
}

/**
 * Build audit metadata for ingress handoff with sealithTransferId tracking.
 * Used to persist transferId on approval cards and audit events.
 */
export function buildIngressHandoffAuditMetadata(
  rule: IngressHandoffRule,
  options: ApplyIngressOptions,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const sealithIntent = extractSealithIntent(rule);

  const metadata: Record<string, unknown> = {
    ingressHandoff: {
      ruleId: rule.id,
      applyTo: rule.applyTo,
      bodyMode: rule.body,
      attachmentMode: rule.attachment,
      sealithMode: sealithIntent.mode,
      sealithRequired: sealithIntent.required,
    },
    ...extra,
  };

  if (rule.audit.sealithTransferId && options.sealithTransferId) {
    metadata.sealithTransferId = options.sealithTransferId;
  }

  if (options.jobId) {
    metadata.jobId = options.jobId;
  }

  return metadata;
}
