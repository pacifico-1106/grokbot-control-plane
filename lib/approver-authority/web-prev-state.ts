/**
 * #279 decision 3 (木村 2026-10-09 22:48): the SoD warn policy and Slack
 * conversation-adapter dashboard saves are gated by approver authority ONLY
 * when a field actually changes.
 *
 * - Previous value unreadable (read error, no row, no client) → treated as changed.
 * - A bot token in the request always counts as changed (tokens cannot be
 *   compared: we never decrypt the stored one for this).
 *
 * The readers here check errors themselves: the general data helpers fall back
 * to defaults / [] on a failed read, which would make "unreadable" look like
 * "unchanged".
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { normalizeSodWarnPolicy } from "@/lib/employees/sod-warn-policy";
import type { SodWarnPolicy } from "@/lib/types";

export type PrevSlackAdapter = { label: string; enabled: boolean; config: Record<string, unknown> };

/** Current SoD warn policy of the org, or null when it cannot be read. */
export async function readPrevSodWarnPolicy(orgId: string): Promise<SodWarnPolicy | null> {
  try {
    if (isDemoMode()) {
      const { getOrgSodWarnPolicy } = await import("@/lib/data/org-context");
      return await getOrgSodWarnPolicy(orgId);
    }
    const admin = createSupabaseAdminClient();
    if (!admin || !orgId) return null;
    const { data, error } = await admin.from("orgs").select("sod_warn_policy").eq("id", orgId).maybeSingle();
    if (error || !data) return null;
    return normalizeSodWarnPolicy((data as { sod_warn_policy?: unknown }).sod_warn_policy);
  } catch {
    return null;
  }
}

/** Current Slack conversation adapter of the org, or null when there is none or it cannot be read. */
export async function readPrevSlackAdapter(orgId: string): Promise<PrevSlackAdapter | null> {
  try {
    if (isDemoMode()) {
      const { listConversationAdapters } = await import("@/lib/data/conversation-adapters");
      const row = (await listConversationAdapters(orgId)).find((a) => a.surface === "slack" && a.orgId === orgId);
      return row ? { label: row.label, enabled: row.enabled, config: { ...(row.config ?? {}) } } : null;
    }
    const admin = createSupabaseAdminClient();
    if (!admin || !orgId) return null;
    const { data, error } = await admin
      .from("org_conversation_adapters")
      .select("label, enabled, config")
      .eq("org_id", orgId)
      .eq("surface", "slack")
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { label?: unknown; enabled?: unknown; config?: unknown };
    const config = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {};
    return { label: String(row.label ?? ""), enabled: row.enabled === true, config };
  } catch {
    return null;
  }
}

/** True unless the previous policy was read and has exactly the same domains. */
export function sodWarnPolicyChanged(prev: SodWarnPolicy | null, next: SodWarnPolicy): boolean {
  if (!prev) return true;
  const a = new Set(prev.domains);
  const b = new Set(next.domains);
  return a.size !== b.size || [...a].some((d) => !b.has(d));
}

/**
 * Fields a Slack conversation-adapter save would change. Empty → nothing
 * changes (not gated). The route always writes config {} so a non-empty stored
 * config counts as a change; the label is compared after the same default the
 * save applies.
 */
export function slackAdapterChangedFields(
  prev: PrevSlackAdapter | null,
  next: { label: string; enabled: boolean; botToken: string }
): string[] {
  const fields: string[] = [];
  if (next.botToken !== "") fields.push("botToken");
  if (!prev) return [...fields, "previous_unreadable_or_missing"];
  if (prev.enabled !== next.enabled) fields.push("enabled");
  if ((next.label.trim() || "Slack 会話投稿") !== prev.label) fields.push("label");
  if (Object.keys(prev.config).length > 0) fields.push("config");
  return fields;
}
