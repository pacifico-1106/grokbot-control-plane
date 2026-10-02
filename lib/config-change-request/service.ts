/**
 * config.change_request — I/O layer (create / approver resolution / fulfil /
 * resolution bookkeeping / approved-Instructions read).
 *
 * Invariants:
 * - Nothing is applied at request time. The only writer is fulfilment of an
 *   APPROVED ticket, behind executeApproval's single-execution claim.
 * - No resolvable approver → refused, nothing created (fail-closed).
 * - Flag OFF at fulfilment time → not applied (rollback = unset the flag).
 * - Applies exactly the stored proposal; Instructions use a base-hash check so
 *   an approver never approves a diff that no longer matches reality.
 */
import { isConfigChangeRequestEnabled, isInboxRoutingEnabled } from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  createApproval,
  getApprovalById,
  listApprovedApprovalsForEmployeeTool,
  updateApprovalMetadata,
} from "@/lib/data/approvals";
import { getEmployee } from "@/lib/data/employees";
import { deleteOrgChannel, getOrgChannel } from "@/lib/data/directory";
import { deleteSlackImEmployeeRoute, isSlackImChannelId } from "@/lib/data/slack-im-routes";
import {
  isTokyo307PilotOrg,
  resolveEmployeeApprovalChannel,
} from "@/lib/data/notification-channels";
import { getIdentityBinding } from "@/lib/employees/employee-identity";
import { applyChannelClassification } from "@/lib/admin-mcp/channel-classify";
import { executeApproval } from "@/lib/approvals/execution";
import { detectSecretInPayload, buildSecretDetectionErrorResponse } from "@/lib/security/secret-detector";
import type { ApprovalRequest, Employee } from "@/lib/types";
import {
  CONFIG_CHANGE_APPROVAL_CLASS,
  CONFIG_CHANGE_PURPOSE,
  CONFIG_CHANGE_TITLE_JA,
  CONFIG_CHANGE_TOOL,
  applyInstructionsProposal,
  buildApproverMessageJa,
  buildDiff,
  buildRequesterNoticeJa,
  hashText,
  isConfigChangeApproval,
  parseConfigChangeApplied,
  parseConfigChangeInput,
  parseConfigChangeMetadata,
  type ConfigChangeApplied,
  type ConfigChangeBefore,
  type ConfigChangeMetadata,
  type ParsedConfigChangeInput,
} from "./core";

export type ApproverResolution =
  | { ok: true; surface: "slack_dm" | "slack" | "telegram" | "line"; channelId: string | null }
  | { ok: false; reason: "no_approver_channel" | "approver_lookup_failed" };

/**
 * Same order as sendApprovalNotifications for business-class tickets:
 * responsible-human Slack DM (inbox routing) → employee/org approval channel
 * (Slack / Telegram / LINE) → pilot Telegram. Anything else is unresolvable.
 */
export async function resolveConfigChangeApprover(
  orgId: string,
  employee: Employee
): Promise<ApproverResolution> {
  try {
    const channel = await resolveEmployeeApprovalChannel(orgId, employee);
    if (channel) {
      if (isInboxRoutingEnabled() && channel.provider === "slack") {
        const binding = await getIdentityBinding(orgId, employee.id).catch(() => null);
        if (binding?.status === "active") {
          return { ok: true, surface: "slack_dm", channelId: channel.id };
        }
      }
      return { ok: true, surface: channel.provider, channelId: channel.id };
    }
    if (await isTokyo307PilotOrg(orgId)) {
      return { ok: true, surface: "telegram", channelId: null };
    }
    return { ok: false, reason: "no_approver_channel" };
  } catch {
    return { ok: false, reason: "approver_lookup_failed" };
  }
}

async function defaultNotify(approval: ApprovalRequest, employee: Employee): Promise<boolean> {
  const { sendApprovalNotifications } = await import("@/lib/notify/channels");
  const results = await sendApprovalNotifications(approval, employee).catch(() => []);
  return results.some((item) => item.ok);
}

export type ConfigChangeDeps = {
  resolveApprover: (orgId: string, employee: Employee) => Promise<ApproverResolution>;
  notify: (approval: ApprovalRequest, employee: Employee) => Promise<boolean>;
};

const DEFAULT_DEPS: ConfigChangeDeps = {
  resolveApprover: resolveConfigChangeApprover,
  notify: defaultNotify,
};

export type ApprovedInstructions = {
  text: string;
  hash: string;
  approvalId: string;
  appliedAt: string;
};

/** Latest applied Instructions overlay for an employee (approved ledger). */
export async function getApprovedInstructions(
  orgId: string,
  employeeId: string,
  opts: { excludeApprovalId?: string } = {}
): Promise<ApprovedInstructions | null> {
  const rows = await listApprovedApprovalsForEmployeeTool(orgId, employeeId, CONFIG_CHANGE_TOOL, 200);
  let best: ApprovedInstructions | null = null;
  for (const row of rows) {
    if (opts.excludeApprovalId && row.id === opts.excludeApprovalId) continue;
    const meta = parseConfigChangeMetadata(row.metadata);
    const applied = parseConfigChangeApplied(row.metadata);
    if (!meta || meta.kind !== "instructions" || !applied?.ok || typeof applied.resultText !== "string") continue;
    if (!best || applied.appliedAt > best.appliedAt) {
      best = {
        text: applied.resultText,
        hash: applied.resultHash || hashText(applied.resultText),
        approvalId: row.id,
        appliedAt: applied.appliedAt,
      };
    }
  }
  return best;
}

async function snapshotBefore(
  orgId: string,
  employeeId: string,
  value: ParsedConfigChangeInput
): Promise<ConfigChangeBefore> {
  const proposal = value.proposal;
  if (proposal.kind === "instructions") {
    const current = await getApprovedInstructions(orgId, employeeId);
    const text = current?.text ?? "";
    return { kind: "instructions", text, hash: hashText(text), sourceApprovalId: current?.approvalId ?? null };
  }
  const channel = await getOrgChannel(orgId, proposal.surface, proposal.externalId);
  return {
    kind: "channel",
    exists: Boolean(channel),
    classification: channel?.classification ?? null,
    mixed: Boolean(channel?.mixed),
    channelId: channel?.id ?? null,
  };
}

export type CreateConfigChangeResult =
  | {
      ok: false;
      code: string;
      messageJa: string;
      applied: false;
      [key: string]: unknown;
    }
  | {
      ok: true;
      code: "no_change";
      applied: false;
      messageJa: string;
    }
  | PendingConfigChange;

export type PendingConfigChange = {
      ok: false;
      code: "needs_approval";
      needs_approval: true;
      applied: false;
      approvalId: string;
      statusToken: string;
      pollUrl: string;
      pollHint: "continue_polling";
      title: string;
      summary: string;
      tool: typeof CONFIG_CHANGE_TOOL;
      diffSummaryJa: string;
      approverSurface: string;
      approverNotified: boolean;
      messageJa: string;
      requesterAckJa: string;
    };

export function isPendingConfigChange(result: CreateConfigChangeResult): result is PendingConfigChange {
  return result.code === "needs_approval" && (result as { needs_approval?: unknown }).needs_approval === true;
}

async function auditRefusal(
  employee: { id: string; orgId: string },
  credentialId: string | null,
  code: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await appendAuditEvent({
    orgId: employee.orgId,
    employeeId: employee.id,
    credentialId,
    action: "config.change_refused",
    purpose: CONFIG_CHANGE_PURPOSE,
    summary: `設定変更依頼を受け付けず（${code}）`,
    metadata: { code, ...extra },
  }).catch(() => null);
}

/**
 * Employee-badge entry point. Never mutates config; at most it creates a
 * pending approval and notifies the approver inbox.
 */
export async function createConfigChangeRequest(
  input: {
    orgId: string;
    employeeId: string;
    credentialId: string | null;
    args: Record<string, unknown>;
  },
  deps: Partial<ConfigChangeDeps> = {}
): Promise<CreateConfigChangeResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (!isConfigChangeRequestEnabled()) {
    return {
      ok: false,
      code: "feature_disabled",
      applied: false,
      messageJa: "P1_CONFIG_CHANGE_REQUEST_ENABLED が OFF のため、この機能は使用できません",
    };
  }
  const employee = await getEmployee(input.employeeId, input.orgId);
  if (!employee || employee.orgId !== input.orgId) {
    return { ok: false, code: "employee_not_found", applied: false, messageJa: "AI社員が見つかりません（fail-closed）" };
  }
  if (employee.status !== "active") {
    return { ok: false, code: "employee_not_active", applied: false, messageJa: "有効なAI社員ではありません（fail-closed）" };
  }

  const parsed = parseConfigChangeInput(input.args);
  if (!parsed.ok) {
    if (parsed.code === "blocked_setting") {
      await auditRefusal(employee, input.credentialId, parsed.code, { kind: String(input.args.kind || "") });
    }
    return { ok: false, code: parsed.code, applied: false, messageJa: parsed.messageJa };
  }
  const value = parsed.value;

  const secret = detectSecretInPayload({
    reason: value.reason,
    instructions: value.proposal.kind === "instructions" ? value.proposal.text : null,
  });
  if (!secret.ok) {
    const rejection = buildSecretDetectionErrorResponse(secret);
    await auditRefusal(employee, input.credentialId, "secret_detected_in_payload");
    return { ...rejection, ok: false, applied: false, messageJa: rejection.messageJa };
  }

  const before = await snapshotBefore(input.orgId, employee.id, value);
  const proposal = value.proposal;

  if (proposal.kind !== "instructions" && before.kind === "channel") {
    if (proposal.kind === "channel_remove" && !before.exists) {
      return { ok: true, code: "no_change", applied: false, messageJa: "このチャネルはチャネル台帳に登録されていません（変更なし）" };
    }
    if (
      proposal.kind === "channel_classification" &&
      before.exists &&
      before.classification === proposal.classification &&
      before.mixed === proposal.mixed
    ) {
      return { ok: true, code: "no_change", applied: false, messageJa: "すでに同じ分類です（変更なし）" };
    }
    if (
      proposal.kind === "channel_classification" &&
      proposal.classification === "internal" &&
      before.exists &&
      (before.classification === "shared_external" || before.mixed)
    ) {
      await auditRefusal(employee, input.credentialId, "connect_cannot_be_internal", { externalId: proposal.externalId });
      return {
        ok: false,
        code: "connect_cannot_be_internal",
        applied: false,
        messageJa: "社外共有（Connect）・混在チャネルは社内に再分類できません。",
      };
    }
  }
  if (proposal.kind === "instructions" && before.kind === "instructions") {
    if (applyInstructionsProposal(before.text, proposal) === before.text) {
      return { ok: true, code: "no_change", applied: false, messageJa: "現在の Instructions と同じ内容です（変更なし）" };
    }
  }

  const approver = await d.resolveApprover(input.orgId, employee);
  if (!approver.ok) {
    await auditRefusal(employee, input.credentialId, "no_approver_resolvable", { reason: approver.reason });
    return {
      ok: false,
      code: "no_approver_resolvable",
      applied: false,
      reason: approver.reason,
      messageJa:
        "承認者に届ける経路（承認インボックス：Slack DM / Slack / Telegram / LINE）が設定されていないため、この変更依頼は受け付けられません。変更は反映していません。管理者に承認インボックスの設定を依頼してください。",
      requesterNoticeJa: `${value.requestedBy.name || "ご依頼者"}さん、申し訳ありません。承認者に確認できる経路が未設定のため、この変更は反映できません。管理者に承認インボックスの設定をご依頼ください。`,
    };
  }

  const diff = buildDiff(proposal, before);
  const summary = buildApproverMessageJa({
    requester: value.requestedBy,
    employeeDisplayName: employee.displayName,
    diffSummaryJa: diff.summaryJa,
    reason: value.reason,
  });
  const configChange: ConfigChangeMetadata = {
    version: 1,
    kind: proposal.kind,
    employeeId: employee.id,
    requestedBy: value.requestedBy,
    reason: value.reason,
    conversation: value.conversation,
    proposal,
    before,
    diffSummaryJa: diff.summaryJa,
    diffLines: diff.lines,
    requestedAt: new Date().toISOString(),
  };

  const created = await createApproval({
    orgId: input.orgId,
    employeeId: employee.id,
    credentialId: input.credentialId || "",
    title: `${CONFIG_CHANGE_TITLE_JA}（${employee.displayName}）`,
    purpose: CONFIG_CHANGE_PURPOSE,
    summary,
    risk: "high",
    tool: CONFIG_CHANGE_TOOL,
    jobId: value.jobId,
    metadata: {
      approvalClass: CONFIG_CHANGE_APPROVAL_CLASS,
      auditClass: CONFIG_CHANGE_APPROVAL_CLASS,
      always_human: true,
      configChange,
    },
  });

  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: employee.id,
    credentialId: input.credentialId,
    action: "config.change_requested",
    purpose: CONFIG_CHANGE_PURPOSE,
    summary: `設定変更の依頼（承認待ち）: ${diff.summaryJa}`,
    metadata: {
      approvalId: created.approval.id,
      kind: proposal.kind,
      requestedBy: value.requestedBy,
      approverSurface: approver.surface,
    },
  }).catch(() => null);

  const notified = await d.notify(created.approval, employee).catch(() => false);

  return {
    ok: false,
    code: "needs_approval",
    needs_approval: true,
    applied: false,
    approvalId: created.approval.id,
    statusToken: created.statusToken,
    pollUrl: created.pollUrl,
    pollHint: "continue_polling",
    title: created.approval.title,
    summary,
    tool: CONFIG_CHANGE_TOOL,
    diffSummaryJa: diff.summaryJa,
    approverSurface: approver.surface,
    approverNotified: notified,
    messageJa: "変更依頼を承認者へ送りました。承認されるまで反映しません。staffpass_get_approval_status で結果を確認してください。",
    requesterAckJa: `${value.requestedBy.name || "ご依頼者"}さん、ありがとうございます。この変更（${diff.summaryJa}）は承認者の確認が必要なため、承認後に反映いたします。`,
  };
}

export type ConfigChangeFulfillment = {
  ok: boolean;
  at: string;
  delivery?: "stub";
  id?: string;
  error?: string;
};

async function applyConfigChange(approval: ApprovalRequest): Promise<ConfigChangeFulfillment> {
  const at = new Date().toISOString();
  const meta = parseConfigChangeMetadata(approval.metadata);
  if (!meta) return { ok: false, at, error: "invalid_config_change_payload" };
  const existing = parseConfigChangeApplied(approval.metadata);
  if (existing?.ok) return { ok: true, at: existing.appliedAt, delivery: "stub" };

  const fail = async (error: string): Promise<ConfigChangeFulfillment> => {
    const applied: ConfigChangeApplied = { ok: false, kind: meta.kind, appliedAt: at, error };
    const fulfillment: ConfigChangeFulfillment = { ok: false, at, error };
    await updateApprovalMetadata(approval, { configChangeApplied: applied, fulfillment }).catch(() => null);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId: approval.employeeId,
      credentialId: approval.credentialId || null,
      action: "config.change_apply_failed",
      purpose: CONFIG_CHANGE_PURPOSE,
      summary: `設定変更（承認済み）を反映できませんでした: ${error}`,
      metadata: { approvalId: approval.id, kind: meta.kind, error, resolvedBy: approval.resolvedBy },
    }).catch(() => null);
    return fulfillment;
  };

  if (!isConfigChangeRequestEnabled()) return fail("feature_disabled");
  if (meta.employeeId !== approval.employeeId) return fail("approval_target_mismatch");
  const employee = await getEmployee(approval.employeeId, approval.orgId);
  if (!employee || employee.status !== "active") return fail("employee_not_active");

  const proposal = meta.proposal;
  let applied: ConfigChangeApplied;
  let channelRowId: string | null = null;
  try {
    if (proposal.kind === "instructions") {
      const current = await getApprovedInstructions(approval.orgId, approval.employeeId, {
        excludeApprovalId: approval.id,
      });
      const currentText = current?.text ?? "";
      const baseHash = meta.before.kind === "instructions" ? meta.before.hash : "";
      if (hashText(currentText) !== baseHash) return fail("stale_base");
      const resultText = applyInstructionsProposal(currentText, proposal);
      applied = {
        ok: true,
        kind: "instructions",
        appliedAt: at,
        resultText,
        resultHash: hashText(resultText),
      };
    } else if (proposal.kind === "channel_classification") {
      const isIm = proposal.surface === "slack" && isSlackImChannelId(proposal.externalId);
      const { channel } = await applyChannelClassification({
        orgId: approval.orgId,
        surface: proposal.surface,
        externalId: proposal.externalId,
        classification: proposal.classification,
        mixed: proposal.mixed,
        // An internal 1:1 DM becomes the requesting employee's mention-free mouth.
        employeeId: isIm ? approval.employeeId : null,
        slackTeamId: proposal.slackTeamId,
      });
      channelRowId = channel.id;
      if (channel.classification !== proposal.classification) {
        // e.g. Slack reports ext_shared → forced shared_external. Report, do not hide it.
        applied = {
          ok: true,
          kind: proposal.kind,
          appliedAt: at,
          channelId: channel.id,
          error: `classification_forced:${channel.classification}`,
        };
      } else {
        applied = { ok: true, kind: proposal.kind, appliedAt: at, channelId: channel.id };
      }
    } else {
      const channel = await getOrgChannel(approval.orgId, proposal.surface, proposal.externalId);
      if (channel) {
        if (proposal.surface === "slack" && isSlackImChannelId(proposal.externalId)) {
          await deleteSlackImEmployeeRoute({ orgId: approval.orgId, slackChannelId: proposal.externalId });
        }
        const removed = await deleteOrgChannel(approval.orgId, channel.id);
        if (!removed) return fail("channel_delete_failed");
        channelRowId = channel.id;
      }
      applied = { ok: true, kind: proposal.kind, appliedAt: at, channelId: channelRowId };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "apply_failed");
  }

  const fulfillment: ConfigChangeFulfillment = {
    ok: true,
    at,
    delivery: "stub",
    ...(channelRowId ? { id: channelRowId } : {}),
  };
  await updateApprovalMetadata(approval, { configChangeApplied: applied, fulfillment });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId || null,
    action: "config.change_applied",
    purpose: CONFIG_CHANGE_PURPOSE,
    summary: `設定変更を承認後に反映: ${meta.diffSummaryJa}`,
    metadata: {
      approvalId: approval.id,
      kind: meta.kind,
      requestedBy: meta.requestedBy,
      resolvedBy: approval.resolvedBy,
      ...(applied.resultHash ? { resultHash: applied.resultHash } : {}),
      ...(channelRowId ? { channelId: channelRowId } : {}),
      ...(applied.error ? { note: applied.error } : {}),
    },
  });
  return fulfillment;
}

/**
 * Fulfil an approved config change exactly once. Returns null for any other ticket.
 * Called from every approval path (dashboard / Slack / Telegram / LINE / proxy / W2).
 */
export async function fulfillConfigChangeApproval(
  approval: ApprovalRequest
): Promise<ConfigChangeFulfillment | null> {
  if (approval.status !== "approved" || !isConfigChangeApproval(approval)) return null;
  try {
    return await executeApproval(approval, () => applyConfigChange(approval));
  } catch (error) {
    return {
      ok: false,
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "approval_execution_failed",
    };
  }
}

export function requesterNoticeForApproval(approval: ApprovalRequest): string | null {
  const meta = parseConfigChangeMetadata(approval.metadata);
  if (!meta) return null;
  const applied = parseConfigChangeApplied(approval.metadata);
  const outcome =
    approval.status === "approved"
      ? applied?.ok
        ? "approved_applied"
        : "approved_not_applied"
      : approval.status === "rejected"
        ? "rejected"
        : approval.status === "revision_requested"
          ? "revision_requested"
          : approval.status === "expired"
            ? "expired"
            : null;
  if (!outcome) return null;
  return buildRequesterNoticeJa({ requester: meta.requestedBy, diffSummaryJa: meta.diffSummaryJa, outcome });
}

/**
 * Bookkeeping when a config-change ticket resolves without being applied
 * (reject / revision). Never throws (called from resolve side effects).
 */
export async function recordConfigChangeResolution(input: {
  approval: ApprovalRequest;
  decision: "approved" | "rejected" | "revision_requested";
  actorEmail: string;
}): Promise<{ requesterNoticeJa: string | null }> {
  try {
    if (!isConfigChangeApproval(input.approval)) return { requesterNoticeJa: null };
    const fresh = (await getApprovalById(input.approval.id, input.approval.orgId)) ?? input.approval;
    const meta = parseConfigChangeMetadata(fresh.metadata);
    if (!meta) return { requesterNoticeJa: null };
    if (input.decision !== "approved") {
      await appendAuditEvent({
        orgId: fresh.orgId,
        employeeId: fresh.employeeId,
        credentialId: fresh.credentialId || null,
        action: "config.change_rejected",
        purpose: CONFIG_CHANGE_PURPOSE,
        actorEmail: input.actorEmail,
        summary: `設定変更の依頼を${input.decision === "rejected" ? "却下" : "差し戻し"}（未反映）: ${meta.diffSummaryJa}`,
        metadata: {
          approvalId: fresh.id,
          kind: meta.kind,
          decision: input.decision,
          requestedBy: meta.requestedBy,
          applied: false,
        },
      });
    }
    const notice = requesterNoticeForApproval({ ...fresh, status: input.decision });
    if (notice) {
      await updateApprovalMetadata(fresh, {
        configChangeOutcome: { decision: input.decision, at: new Date().toISOString(), requesterNoticeJa: notice },
      }).catch(() => null);
    }
    return { requesterNoticeJa: notice };
  } catch {
    return { requesterNoticeJa: null };
  }
}
