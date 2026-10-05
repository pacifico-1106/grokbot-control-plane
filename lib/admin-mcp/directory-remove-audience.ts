/**
 * channels.remove / parties.remove: the audience the gateway would judge
 * AFTER the delete (木村 review 2026-10-05 10:39, before the flag goes ON).
 *
 * Deleting a ledger row makes resolveAudience (lib/gateway/audience.ts) fall
 * back to a different rule:
 *  - org_channels row gone → the slack_channel party (if any) decides the
 *    channel signal; a shared_external / mixed / unknown row no longer forces
 *    external;
 *  - slack_user party gone → the org rule's auto-internal Slack teams decide
 *    (a guest of the own workspace carries the own team id);
 *  - mail_address party gone → the email_domain party, then the org rule's
 *    internal email domains;
 *  - email_domain party gone → the org rule's internal email domains.
 * A delete that would turn an external / mixed / guest / outside-domain
 * destination internal is refused (request AND fulfillment). Making something
 * internal must be an explicit, reviewed classification
 * (channels.classify / parties.upsert), never a side effect of a delete.
 *
 * Every read is strict: a store error throws (never "not registered", which
 * would be the permissive answer here).
 */
import { getOrgInternalAudienceRuleStrict, isEmailDomainInternal } from "@/lib/data/internal-audience-rule";
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { OrgChannel, OrgInternalAudienceRule, OrgParty, OrgPartyKind } from "@/lib/types";

export const DIRECTORY_REMOVE_RELAXES_AUDIENCE = "directory_remove_relaxes_audience";
export const DIRECTORY_REMOVE_AUDIENCE_CHECK_FAILED = "audience_check_failed";

type Side = "internal" | "external";
export type AudienceAfterRemove = {
  before: Side;
  /** external | mixed | unknown | internal (channels); internal | external (parties). */
  beforeKind: string;
  after: Side;
  /** Why the destination would be judged `after` once the row is gone. */
  afterReasonJa: string;
};

export function removeRelaxesAudience(check: AudienceAfterRemove): boolean {
  return check.before === "external" && check.after === "internal";
}

function normalizeIdentifier(kind: OrgPartyKind, raw: string): string {
  const value = raw.trim();
  if (kind === "email_domain" || kind === "mail_address") return value.toLowerCase();
  if (kind === "phone") return value.replace(/[^\d+]/g, "") || value;
  return value;
}

/** org_parties by (kind, identifier), org-scoped; a store error throws. */
async function findPartyStrict(orgId: string, kind: OrgPartyKind, identifier: string): Promise<OrgParty | null> {
  const normalized = normalizeIdentifier(kind, identifier);
  if (!orgId || !normalized) return null;
  if (isDemoMode()) return getOrgParty(orgId, kind, normalized);
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_parties")
    .select("id, org_id, kind, identifier, audience")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("identifier", normalized)
    .maybeSingle();
  if (error) throw new Error("party_lookup_failed");
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind,
    identifier: String(row.identifier),
    audience: row.audience === "internal" ? "internal" : "external",
    createdAt: "",
    updatedAt: "",
  };
}

const EXTERNAL_UNREGISTERED_JA = "未登録になり、社外扱い（承認が必要）";

export async function channelAudienceAfterRemove(orgId: string, channel: OrgChannel): Promise<AudienceAfterRemove> {
  const beforeKind = channel.mixed
    ? "mixed"
    : channel.classification === "shared_external"
      ? "external"
      : channel.classification === "unknown"
        ? "unknown"
        : "internal";
  const before: Side = beforeKind === "internal" ? "internal" : "external";
  // resolveAudience falls back to the slack_channel party when the row is gone.
  const party = await findPartyStrict(orgId, "slack_channel", channel.externalId);
  if (party?.audience === "internal") {
    return { before, beforeKind, after: "internal", afterReasonJa: `相手台帳で slack_channel ${channel.externalId} が社内として登録されているため社内扱い` };
  }
  return { before, beforeKind, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
}

function teamRuleInternal(rule: OrgInternalAudienceRule): boolean {
  return rule.autoSlackTeamInternal && rule.slackTeamIds.length > 0;
}

export async function partyAudienceAfterRemove(orgId: string, party: OrgParty): Promise<AudienceAfterRemove> {
  const before: Side = party.audience === "internal" ? "internal" : "external";
  const base = { before, beforeKind: before };
  switch (party.kind) {
    case "slack_user": {
      const rule = await getOrgInternalAudienceRuleStrict(orgId);
      if (teamRuleInternal(rule)) {
        return {
          ...base,
          after: "internal",
          afterReasonJa: `自社ワークスペース（${rule.slackTeamIds.join("・")}）のユーザーは自動で社内扱いのため、このユーザー（ゲストを含む）が社内扱いになり得る`,
        };
      }
      return { ...base, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
    }
    case "mail_address": {
      const at = party.identifier.lastIndexOf("@");
      const domain = at > 0 ? party.identifier.slice(at + 1).trim().toLowerCase() : "";
      if (domain) {
        const domainParty = await findPartyStrict(orgId, "email_domain", domain);
        if (domainParty) {
          return domainParty.audience === "internal"
            ? { ...base, after: "internal", afterReasonJa: `相手台帳でドメイン ${domain} が社内として登録されているため社内扱い` }
            : { ...base, after: "external", afterReasonJa: `相手台帳でドメイン ${domain} が社外のため社外扱い` };
        }
      }
      const rule = await getOrgInternalAudienceRuleStrict(orgId);
      if (isEmailDomainInternal(rule, party.identifier)) {
        return { ...base, after: "internal", afterReasonJa: `社内判定ルールでドメイン ${domain} が社内のため社内扱い` };
      }
      return { ...base, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
    }
    case "email_domain": {
      const rule = await getOrgInternalAudienceRuleStrict(orgId);
      if (isEmailDomainInternal(rule, `x@${party.identifier}`)) {
        return { ...base, after: "internal", afterReasonJa: `社内判定ルールでドメイン ${party.identifier} が社内のため、このドメインのアドレスは社内扱い` };
      }
      return { ...base, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
    }
    case "slack_channel": {
      // Only consulted when the channel has no org_channels row; with a row,
      // the row decides before and after alike.
      const row = await getOrgChannel(orgId, "slack", party.identifier);
      if (row) {
        const side: Side = row.classification === "internal" && !row.mixed ? "internal" : "external";
        return { before: side, beforeKind: side, after: side, afterReasonJa: "チャネル台帳の分類のまま（相手台帳のこの登録は使われていません）" };
      }
      return { ...base, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
    }
    default:
      return { ...base, after: "external", afterReasonJa: EXTERNAL_UNREGISTERED_JA };
  }
}

/** One card line: what the gateway will judge after the delete. */
export function afterRemoveCardLine(check: AudienceAfterRemove): string {
  return `削除後の判定: ${check.after === "internal" ? "社内" : "社外"}（${check.afterReasonJa}）。`;
}

const BEFORE_KIND_JA: Record<string, string> = {
  external: "社外",
  mixed: "社内外の混在",
  unknown: "未分類（社外扱い）",
  internal: "社内",
};

/** Refusal body (request and fulfillment share code / wording). */
export function relaxRefusal(tool: "channels.remove" | "parties.remove", subject: string, check: AudienceAfterRemove, kind?: OrgPartyKind) {
  const beforeJa = BEFORE_KIND_JA[check.beforeKind] ?? "社外";
  const messageJa = `${subject} を削除すると、いま ${beforeJa} の判定が社内に変わります（${check.afterReasonJa}）。削除しませんでした。`;
  const nextStepJa =
    tool === "channels.remove"
      ? "社内扱いが正しければ channels.classify で分類を明示的に変えてください（人の承認つき）。社外のまま台帳から外したい場合は、先に parties.upsert で slack_channel の登録を社外にしてから依頼し直してください。"
      : kind === "slack_user"
        ? "社内扱いが正しければ parties.upsert で audience=internal に変えてください（人の承認つき）。社外のままにする場合は、この登録を残してください（自社ワークスペースのゲストなどを社外扱いにしている登録です）。"
        : "社内扱いが正しければ parties.upsert で audience=internal に変えてください（人の承認つき）。社外のままにする場合は、この登録を残してください（社内ドメインの中の社外の宛先を社外扱いにしている登録です）。";
  return {
    code: DIRECTORY_REMOVE_RELAXES_AUDIENCE,
    retryable: false,
    audienceBefore: check.before,
    audienceAfter: check.after,
    beforeKind: check.beforeKind,
    messageJa,
    nextStepJa,
  };
}
