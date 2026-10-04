/**
 * Retry cap for the approved-attachment re-run (2026-10-04, 木村 #255 second
 * round, decision 4). Behind APPROVAL_ATTACHMENT_RECONCILE_ENABLED (OFF → no
 * cap, nothing recorded).
 *
 * Counter: per approval + Slack error code, consecutive definite failures,
 * metadata.attachmentUploadStreak = { code, count, lastAt } (written by the
 * finish RPC under the row lock; lib/approvals/attachment-upload-claim.ts).
 * At ATTACHMENT_RETRY_CAP the capped claim refuses → the re-run does not call
 * Slack and returns the same reinvokeReason.
 *
 * Reset trigger (generic, no tenant / tool-instance hardcoding): an audit row
 * `setup.tool_succeeded` in the SAME org created after the streak's lastAt. It
 * is recorded when a settings-type admin tool succeeds:
 *   - any `setup.*` admin tool: approved fulfillment ok, or a direct (not
 *     queued) admin MCP answer with ok:true (e.g. setup.slackStatus all ready)
 *   - employees.postingIdentity.set (changes which token the upload uses)
 *   - setup.slackAuthorizeLink.issue only on COMPLETION (the employee pressed
 *     "許可する" and the user token was saved) — issuing the link changes nothing
 * The capped claim RPC checks it inside the same row lock and clears the streak.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getRuntimeAudit } from "@/lib/demo-data";
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const ATTACHMENT_RETRY_CAP = 3;
export const SETUP_TOOL_SUCCEEDED_AUDIT = "setup.tool_succeeded" as const;
export type SettingsChangeSource = "admin_fulfillment" | "admin_tool" | "authorize_link_completed";

const AUTHORIZE_LINK_TOOL = "setup.slackAuthorizeLink.issue";
/** Settings tools outside the setup.* namespace that change what a Slack upload uses. */
const SETTINGS_TOOLS_OUTSIDE_SETUP: ReadonlySet<string> = new Set(["employees.postingIdentity.set"]);

export function countsAsSettingsChange(tool: string, source: SettingsChangeSource): boolean {
  if (tool === AUTHORIZE_LINK_TOOL || source === "authorize_link_completed") {
    return tool === AUTHORIZE_LINK_TOOL && source === "authorize_link_completed";
  }
  return tool.startsWith("setup.") || SETTINGS_TOOLS_OUTSIDE_SETUP.has(tool);
}

/** Records the reset marker (flag ON + a settings-type tool only). Best effort: never throws. */
export async function recordSetupToolSucceeded(input: {
  orgId: string;
  tool: string;
  source: SettingsChangeSource;
  approvalId?: string | null;
  employeeId?: string | null;
}): Promise<void> {
  if (!isApprovalAttachmentReconcileEnabled() || !input.orgId || !countsAsSettingsChange(input.tool, input.source)) return;
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId ?? null,
    credentialId: null,
    action: SETUP_TOOL_SUCCEEDED_AUDIT,
    purpose: "setup",
    summary: `設定系ツールが成功: ${input.tool}（同じ Slack エラーで止めていた添付の再実行を再開できます）`,
    // tool name / source / ticket id only — never arguments, tokens or results
    metadata: { tool: input.tool, source: input.source, ...(input.approvalId ? { approvalId: input.approvalId } : {}) },
  }).catch(() => undefined);
}

/**
 * Demo mirror of the capped claim RPC's check (production checks inside
 * claim_approval_attachment_upload_capped, under the row lock). Errors → false
 * (stays capped: no Slack call).
 */
export async function hasSetupToolSucceededSince(orgId: string, sinceIso: string): Promise<boolean> {
  const since = Date.parse(sinceIso);
  if (!orgId || !Number.isFinite(since)) return false;
  if (isDemoMode()) {
    return getRuntimeAudit().some((e) => e.orgId === orgId && e.action === SETUP_TOOL_SUCCEEDED_AUDIT
      && Date.parse(e.createdAt) > since);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.from("audit_events").select("id")
      .eq("org_id", orgId).eq("action", SETUP_TOOL_SUCCEEDED_AUDIT).gt("created_at", new Date(since).toISOString()).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
