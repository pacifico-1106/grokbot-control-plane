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

/** Reject malformed security policy rather than coercing it into a wider audience. */
export function validateInternalAudienceRulePatch(raw: Record<string, unknown>): Partial<OrgInternalAudienceRule> {
  const out: Partial<OrgInternalAudienceRule> = {};
  for (const key of ["emailDomains", "slackTeamIds"] as const) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (!Array.isArray(value) || value.length > 100 || value.some((v) =>
      typeof v !== "string" || !(key === "emailDomains"
        ? /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
        : /^T[A-Z0-9]{2,30}$/i).test(v.trim()))) {
      throw new Error("invalid_internal_audience_rule");
    }
    out[key] = [...new Set(value.map((v: string) => key === "emailDomains" ? v.trim().toLowerCase() : v.trim().toUpperCase()))];
  }
  if (raw.autoSlackTeamInternal !== undefined) {
    if (typeof raw.autoSlackTeamInternal !== "boolean") throw new Error("invalid_internal_audience_rule");
    out.autoSlackTeamInternal = raw.autoSlackTeamInternal;
  }
  return out;
}

export async function setOrgInternalAudienceRule(
  orgId: string,
  rule: Partial<OrgInternalAudienceRule>,
  updatedBy: string
): Promise<OrgInternalAudienceRule> {
  rule = validateInternalAudienceRulePatch(rule);
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
