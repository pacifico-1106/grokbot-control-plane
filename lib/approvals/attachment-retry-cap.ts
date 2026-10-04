/**
 * Retry cap for the approved-attachment re-run (2026-10-04, 木村 #255 second
 * round, decision 4; third round d / e / g / h). Behind
 * APPROVAL_ATTACHMENT_RECONCILE_ENABLED (OFF → no cap, nothing recorded).
 *
 * Counter: per approval + Slack error code, consecutive definite failures,
 * metadata.attachmentUploadStreak = { code, count, lastAt } (written by the
 * finish RPC under the row lock; lib/approvals/attachment-upload-claim.ts).
 * At ATTACHMENT_RETRY_CAP (fixed 3, not configurable — 木村 g) the capped claim
 * refuses → the re-run does not call Slack and returns the same reinvokeReason.
 *
 * Reset signal (木村 h): public.org_settings_changes — one row per org with the
 * time of the last settings change. RLS on, no policy, anon / authenticated
 * revoked: only service_role (the server) reads or writes it, through the RPC
 * record_org_settings_change. The capped claim RPC compares it with the
 * streak's lastAt inside the same row lock. audit_events is NOT read (org
 * members can insert audit rows); the `setup.tool_succeeded` audit row is only
 * a trail.
 *
 * What counts as a settings change (generic, no tenant hardcoding):
 *   - a registered admin MCP tool that is NOT read-only (READ_ONLY_ADMIN_TOOLS)
 *     in the setup.* family, or employees.postingIdentity.set — SETTINGS_RESET_TOOLS
 *     (read-only setup.slackStatus / …Status / connectInternalBase never count; 木村 e)
 *   - setup.slackAuthorizeLink.issue only on COMPLETION (the employee pressed
 *     「許可する」 and the user token was saved) — issuing the link changes nothing
 *   - the dashboard save of the Slack conversation adapter (bot token; 木村 d)
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { isApprovalAttachmentReconcileEnabled } from "@/lib/feature-flags";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const ATTACHMENT_RETRY_CAP = 3;
export const SETUP_TOOL_SUCCEEDED_AUDIT = "setup.tool_succeeded" as const;
export type SettingsChangeSource = "admin_fulfillment" | "admin_tool" | "authorize_link_completed" | "dashboard_settings";
/** Dashboard save of the Slack conversation adapter (bot token); 木村 third round d. */
export const DASHBOARD_SLACK_ADAPTER_SAVE = "dashboard.conversationAdapter.slack" as const;

const AUTHORIZE_LINK_TOOL = "setup.slackAuthorizeLink.issue";
/** Settings tools outside the setup.* namespace that change what a Slack upload uses. */
const SETTINGS_TOOLS_OUTSIDE_SETUP: ReadonlySet<string> = new Set(["employees.postingIdentity.set"]);
const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_ADMIN_TOOLS as readonly string[]);

/** The admin tools whose success resets the cap (derived from the registry; listed in the PR). */
export const SETTINGS_RESET_TOOLS: readonly string[] = (ADMIN_MCP_TOOL_NAMES as readonly string[])
  .filter((t) => (t.startsWith("setup.") || SETTINGS_TOOLS_OUTSIDE_SETUP.has(t)) && !READ_ONLY.has(t));
const RESET_TOOLS: ReadonlySet<string> = new Set(SETTINGS_RESET_TOOLS);
export type SettingsResetSignal = { tool: string; source: SettingsChangeSource };
/** TDD stub (fourth round): the explicit allow-list is implemented in the next commit. */
export const SETTINGS_RESET_SIGNALS: readonly SettingsResetSignal[] = [];

export function countsAsSettingsChange(tool: string, source: SettingsChangeSource): boolean {
  if (source === "dashboard_settings" || tool === DASHBOARD_SLACK_ADAPTER_SAVE) {
    return source === "dashboard_settings" && tool === DASHBOARD_SLACK_ADAPTER_SAVE;
  }
  if (tool === AUTHORIZE_LINK_TOOL || source === "authorize_link_completed") {
    return tool === AUTHORIZE_LINK_TOOL && source === "authorize_link_completed";
  }
  return RESET_TOOLS.has(tool);
}

/** Demo mirror of public.org_settings_changes (org → last change, ms). */
const demoSettingsChanges = new Map<string, number>();

/**
 * Records the reset signal (flag ON + a settings change only) and an audit
 * trail row. Best effort: never throws, never changes the caller's result.
 */
export async function recordSetupToolSucceeded(input: {
  orgId: string;
  tool: string;
  source: SettingsChangeSource;
  approvalId?: string | null;
  employeeId?: string | null;
}): Promise<void> {
  if (!isApprovalAttachmentReconcileEnabled() || !input.orgId || !countsAsSettingsChange(input.tool, input.source)) return;
  if (isDemoMode()) {
    demoSettingsChanges.set(input.orgId, Math.max(Date.now(), demoSettingsChanges.get(input.orgId) ?? 0));
  } else {
    const admin = createSupabaseAdminClient();
    if (admin) {
      try {
        await admin.rpc("record_org_settings_change", { p_org: input.orgId, p_tool: input.tool, p_source: input.source });
      } catch {
        // no signal → the cap simply stays (fail closed: no extra Slack call)
      }
    }
  }
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId ?? null,
    credentialId: null,
    action: SETUP_TOOL_SUCCEEDED_AUDIT,
    purpose: "setup",
    summary: `設定が変わりました: ${input.tool}（同じ Slack エラーで止めていた添付の再実行を再開できます）`,
    // tool name / source / ticket id only — never arguments, tokens or results
    metadata: { tool: input.tool, source: input.source, ...(input.approvalId ? { approvalId: input.approvalId } : {}) },
  }).catch(() => undefined);
}

/**
 * True when the org's settings-change signal is newer than sinceIso. Demo:
 * the in-process map; production reads public.org_settings_changes with the
 * service role (the capped claim RPC does the same check under the row lock).
 * Errors → false (stays capped: no Slack call).
 */
export async function settingsChangedSince(orgId: string, sinceIso: string): Promise<boolean> {
  const since = Date.parse(sinceIso);
  if (!orgId || !Number.isFinite(since)) return false;
  if (isDemoMode()) return (demoSettingsChanges.get(orgId) ?? -Infinity) > since;
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data, error } = await admin.from("org_settings_changes").select("changed_at")
      .eq("org_id", orgId).gt("changed_at", new Date(since).toISOString()).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
