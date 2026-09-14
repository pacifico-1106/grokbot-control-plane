/**
 * Org-level internal audience rule for large/stablo-scale channels.
 * Internal = parties allowlist UNION emailDomains UNION slackTeamIds.
 * Connect guests / unregistered → external (fail-closed).
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { OrgInternalAudienceRule } from "@/lib/types";

function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_RULE: OrgInternalAudienceRule = {
  version: 1,
  emailDomains: [],
  slackTeamIds: [],
  autoSlackTeamInternal: false,
  updatedAt: nowIso(),
  updatedBy: "system",
};

let demoRule: OrgInternalAudienceRule | null = null;

function normalizeRule(
  raw: unknown
): OrgInternalAudienceRule {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_RULE, updatedAt: nowIso() };
  }
  const obj = raw as Record<string, unknown>;
  const emailDomains = Array.isArray(obj.emailDomains)
    ? obj.emailDomains
        .map((d) => String(d).trim().toLowerCase())
        .filter(Boolean)
    : [];
  const slackTeamIds = Array.isArray(obj.slackTeamIds)
    ? obj.slackTeamIds
        .map((t) => String(t).trim().toUpperCase())
        .filter(Boolean)
    : [];
  const autoSlackTeamInternal = obj.autoSlackTeamInternal === true;
  return {
    version: 1,
    emailDomains,
    slackTeamIds,
    autoSlackTeamInternal,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : nowIso(),
    updatedBy: typeof obj.updatedBy === "string" ? obj.updatedBy : "system",
  };
}

export async function getOrgInternalAudienceRule(
  orgId?: string | null
): Promise<OrgInternalAudienceRule> {
  if (isDemoMode()) {
    return demoRule ?? { ...DEFAULT_RULE, updatedAt: nowIso() };
  }
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) {
    return { ...DEFAULT_RULE, updatedAt: nowIso() };
  }
  const { data } = await admin
    .from("orgs")
    .select("internal_audience_rule")
    .eq("id", orgId)
    .maybeSingle();
  return normalizeRule(
    (data as { internal_audience_rule?: unknown } | null)?.internal_audience_rule
  );
}

export async function setOrgInternalAudienceRule(
  orgId: string,
  rule: Partial<OrgInternalAudienceRule>,
  updatedBy: string
): Promise<OrgInternalAudienceRule> {
  const current = await getOrgInternalAudienceRule(orgId);
  const next: OrgInternalAudienceRule = {
    version: 1,
    emailDomains:
      rule.emailDomains !== undefined
        ? rule.emailDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)
        : current.emailDomains,
    slackTeamIds:
      rule.slackTeamIds !== undefined
        ? rule.slackTeamIds.map((t) => t.trim().toUpperCase()).filter(Boolean)
        : current.slackTeamIds,
    autoSlackTeamInternal:
      rule.autoSlackTeamInternal !== undefined
        ? rule.autoSlackTeamInternal
        : current.autoSlackTeamInternal,
    updatedAt: nowIso(),
    updatedBy,
  };
  if (isDemoMode()) {
    demoRule = next;
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { error } = await admin
    .from("orgs")
    .update({
      internal_audience_rule: next,
      updated_at: nowIso(),
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
  return next;
}

/**
 * Check if a Slack user's team matches the org's internal teams.
 * Returns true if autoSlackTeamInternal=true AND slackTeamId is in the rule.
 */
export function isSlackTeamInternal(
  rule: OrgInternalAudienceRule,
  slackTeamId: string | undefined | null
): boolean {
  if (!rule.autoSlackTeamInternal || !slackTeamId) return false;
  const team = slackTeamId.trim().toUpperCase();
  return rule.slackTeamIds.some((t) => t === team);
}

/**
 * Check if an email domain matches the org's internal domains.
 */
export function isEmailDomainInternal(
  rule: OrgInternalAudienceRule,
  email: string | undefined | null
): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return rule.emailDomains.some((d) => d === domain);
}

export function clearDemoRule(): void {
  demoRule = null;
}
