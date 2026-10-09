/**
 * PR-B: open channels.classify (+ parties.upsert for mixed Slack channels)
 * tickets for a channel the org joined. Same admin approval machinery as the
 * admin MCP queue (approvalClass admin, always_human, metadata.adminMutation
 * applied only by fulfillApprovedAdmin after a HUMAN approval), delivered to
 * the org's approval channel (承認窓口) as a one-tap card.
 *
 * - Never applies anything itself.
 * - One open ticket per org × channel (claim_channel_classify_proposal); no
 *   reopen while pending or after a decision unless the material facts change.
 * - Dedupe store unavailable → no ticket (cannot prove it is not a duplicate).
 * - Requester is "system" (no admin agent), so no agent can self-approve it;
 *   resolution goes through the normal admin-class approver rules.
 * - (follow-up N3) No admin approver for the org (no admin route with voters
 *   and no owner; lookup error counts as none) → no ticket, ids-only ops
 *   notice, tenant audit row. Checked here regardless of
 *   ADMIN_APPROVER_POLICY_REQUIRED.
 * - (follow-up H1) Per-org hourly cap on new tickets
 *   (CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR, all triggers): over the cap →
 *   claim released, no ticket, ONE summary notice per window.
 */
import { isChannelClassifyProposalsEnabled } from "@/lib/channel-classify/flags";
import { createApproval as createApprovalRow } from "@/lib/data/approvals";
import { appendAuditEvent } from "@/lib/data/audit";
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import {
  attachChannelClassifyProposal,
  claimChannelClassifyProposal,
  releaseChannelClassifyProposal,
} from "@/lib/data/channel-classify";
import { ADMIN_AUDIT_CLASS, auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { buildChannelClassifyCardSummaryJa, buildPartyUpsertCardSummaryJa } from "@/lib/channel-classify/approval-card";
import {
  buildChannelProposal,
  channelFactsHash,
  surfaceLabel,
  type ChannelFacts,
  type ProposedTicket,
} from "@/lib/channel-classify/core";
import { createHash } from "node:crypto";
import { maxProposalsPerHour, takeOrgBudget } from "@/lib/channel-classify/budget";
import { notifyChannelStuck, notifyOpsIdsOnly } from "@/lib/channel-classify/stuck-notify";
import { canProceedWithAdminApproval } from "@/lib/approval-workflow/admin-policy";
import { getOrgApprovalWorkflowPolicy } from "@/lib/approval-workflow/data";
import { getOrgOwnerIds } from "@/lib/data/members";
import type { ApprovalRequest } from "@/lib/types";

export type ProposalTrigger =
  | "slack_member_joined"
  | "slack_channel_joined"
  | "line_join"
  | "telegram_my_chat_member"
  | "backfill"
  | "egress_denied";

export type ProposalOutcome = {
  state:
    | "created"
    | "pending"
    | "decided"
    | "in_flight"
    | "registered"
    | "skipped"
    | "flag_off"
    | "rate_limited"
    | "no_approver"
    | "error";
  approvalId?: string;
  partyApprovalIds?: string[];
  decidedStatus?: string;
  reason?: string;
};

export const MAX_PARTY_PROPOSALS = 5;

type Deps = {
  createApproval: typeof createApprovalRow;
  notifyApproval: (approval: ApprovalRequest) => Promise<boolean>;
  hasApprover: (orgId: string) => Promise<boolean>;
};

async function defaultNotify(approval: ApprovalRequest): Promise<boolean> {
  const { sendApprovalNotifications } = await import("@/lib/notify/channels");
  const results = await sendApprovalNotifications(approval, null).catch(() => []);
  return results.some((row) => row.ok);
}

/** Same rule as the admin MCP queue: an admin route with voters, else an org owner. Errors → false. */
export async function defaultHasAdminApprover(orgId: string): Promise<boolean> {
  if (!orgId) return false;
  try {
    const [policy, owners] = await Promise.all([getOrgApprovalWorkflowPolicy(orgId), getOrgOwnerIds(orgId)]);
    return canProceedWithAdminApproval(policy, owners);
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: Deps = { createApproval: createApprovalRow, notifyApproval: defaultNotify, hasApprover: defaultHasAdminApprover };
let deps: Deps = DEFAULT_DEPS;

export function setProposalDepsForTests(override: Partial<Deps> | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

/** Already in the ledger (channel row, or a Slack slack_channel party). */
export async function isChannelRegistered(orgId: string, ref: { surface: ChannelFacts["surface"]; externalId: string }): Promise<boolean> {
  if (await getOrgChannel(orgId, ref.surface, ref.externalId)) return true;
  if (ref.surface === "slack" && (await getOrgParty(orgId, "slack_channel", ref.externalId))) return true;
  if (ref.surface === "line" && (await getOrgParty(orgId, "line", ref.externalId))) return true;
  return false;
}

function publicFacts(f: ChannelFacts): Record<string, unknown> {
  // Flags and counts only (no member ids in the ticket metadata).
  return {
    conversationType: f.conversationType,
    isPrivate: f.isPrivate,
    isShared: f.isShared,
    isExtShared: f.isExtShared,
    memberCount: f.memberCount,
    internalMembers: f.internalMembers,
    externalMembers: f.externalMembers,
    guestMembers: f.guestMembers,
    membersComplete: f.membersComplete,
  };
}

async function openTicket(input: {
  orgId: string;
  ticket: ProposedTicket;
  factsHash: string;
  title: string;
  summary: string;
  trigger: ProposalTrigger;
  metadata: Record<string, unknown>;
}): Promise<{ ok: true; approval: ApprovalRequest } | { ok: false; reason: string }> {
  const created = await deps
    .createApproval({
      orgId: input.orgId,
      employeeId: "",
      credentialId: "",
      title: input.title,
      purpose: auditActionForAdminTool(input.ticket.tool),
      summary: input.summary,
      risk: "high",
      tool: input.ticket.tool,
      jobId: `channel_classify_${input.trigger}_${Date.now().toString(36)}`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalClass: ADMIN_AUDIT_CLASS,
        auditAction: auditActionForAdminTool(input.ticket.tool),
        always_human: true,
        adminTool: input.ticket.tool,
        isAdminMcpTool: true,
        adminMutation: input.ticket.args,
        proposalRequester: { kind: "system", source: input.trigger },
        ...input.metadata,
      },
    })
    .catch(() => null);
  if (!created) {
    await releaseChannelClassifyProposal({ orgId: input.orgId, key: input.ticket.key });
    return { ok: false, reason: "ticket_create_failed" };
  }
  const attached = await attachChannelClassifyProposal({ orgId: input.orgId, key: input.ticket.key, approvalId: created.approval.id });
  if (!attached) {
    // The ticket exists and is a normal pending admin ticket; dedupe for this
    // key re-claims after the stale window. Reported, not hidden.
    await audit(input.orgId, "channel_classify.proposal_failed", `分類提案の重複防止記録に失敗（${input.ticket.key}）`, {
      approvalId: created.approval.id,
      reason: "attach_failed",
    });
  }
  await deps.notifyApproval(created.approval).catch(() => false);
  return { ok: true, approval: created.approval };
}

async function audit(orgId: string, action: "channel_classify.proposed" | "channel_classify.proposal_failed", summary: string, metadata: Record<string, unknown>) {
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action,
    purpose: "admin.channel",
    summary,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, ...metadata },
  }).catch(() => undefined);
}

/** H1: take one unit of the org's hourly proposal budget; the first overflow sends the one summary. */
async function withinProposalBudget(orgId: string, trigger: ProposalTrigger): Promise<boolean> {
  const limit = maxProposalsPerHour();
  const verdict = await takeOrgBudget(orgId, "proposals", limit);
  if (verdict === "allowed") return true;
  if (verdict === "over_first") {
    await audit(orgId, "channel_classify.proposal_failed", `分類提案が 1 時間あたりの上限（${limit}件）に達したため停止`, {
      reason: "proposals_per_hour",
      limit,
      trigger,
    });
    await notifyChannelStuck({ orgId, kind: "proposal_rate_limited", reason: "proposals_per_hour", limit, dedupeKey: "org" });
  }
  return false;
}

export async function proposeChannelClassification(input: {
  orgId: string;
  facts: ChannelFacts;
  trigger: ProposalTrigger;
}): Promise<ProposalOutcome> {
  if (!isChannelClassifyProposalsEnabled()) return { state: "flag_off" };
  const { orgId, facts, trigger } = input;
  try {
    if (!orgId || !facts.externalId) return { state: "skipped", reason: "invalid_input" };
    if (await isChannelRegistered(orgId, facts)) return { state: "registered" };
    const registeredPartyIds = new Set<string>();
    for (const id of facts.internalMemberIds) {
      if (await getOrgParty(orgId, "slack_user", id)) registeredPartyIds.add(id);
    }
    const proposal = buildChannelProposal(facts, { registeredPartyIds, maxParties: MAX_PARTY_PROPOSALS });
    if (proposal.skip) return { state: "skipped", reason: proposal.skip };
    if (!(await deps.hasApprover(orgId).catch(() => false))) {
      await audit(orgId, "channel_classify.proposal_failed", `管理承認者が未設定のため分類提案を作りませんでした（${facts.externalId}）`, {
        key: proposal.classify.key,
        reason: "no_admin_approver",
        trigger,
      });
      await notifyOpsIdsOnly({ orgId, reason: "no_admin_approver", ref: { surface: facts.surface, externalId: facts.externalId }, trigger });
      return { state: "no_approver", reason: "no_admin_approver" };
    }
    const factsHash = channelFactsHash(facts);
    const claim = await claimChannelClassifyProposal({ orgId, key: proposal.classify.key, factsHash });
    if (claim.state === "pending") return { state: "pending", approvalId: claim.approvalId };
    if (claim.state === "decided") return { state: "decided", approvalId: claim.approvalId, decidedStatus: claim.status };
    if (claim.state === "in_flight") return { state: "in_flight" };
    if (claim.state !== "claimed") {
      await audit(orgId, "channel_classify.proposal_failed", `分類提案を作れませんでした（重複防止ストア ${claim.state}）`, {
        key: proposal.classify.key,
        reason: `dedupe_${claim.state}`,
        trigger,
      });
      return { state: "error", reason: `dedupe_${claim.state}` };
    }
    if (!(await withinProposalBudget(orgId, trigger))) {
      await releaseChannelClassifyProposal({ orgId, key: proposal.classify.key });
      return { state: "rate_limited", reason: "proposals_per_hour" };
    }

    const summary = await buildChannelClassifyCardSummaryJa(
      orgId,
      {
        surface: facts.surface,
        externalId: facts.externalId,
        classification: proposal.suggestion.classification,
        mixed: proposal.suggestion.mixed,
      },
      { requester: "system", facts, suggestion: proposal.suggestion }
    ).catch(() => `【自動提案・未反映】${surfaceLabel(facts.surface)} ${facts.externalId} の分類`);
    const opened = await openTicket({
      orgId,
      ticket: proposal.classify,
      factsHash,
      title: `チャネル分類の提案（${surfaceLabel(facts.surface)}）`,
      summary,
      trigger,
      metadata: {
        channelClassifyProposal: {
          version: 1,
          surface: facts.surface,
          externalId: facts.externalId,
          trigger,
          factsHash,
          basis: proposal.suggestion.basis,
          facts: publicFacts(facts),
          partiesTruncated: proposal.partiesTruncated,
        },
      },
    });
    if (!opened.ok) {
      await audit(orgId, "channel_classify.proposal_failed", `分類提案を作れませんでした（${facts.externalId}）`, {
        key: proposal.classify.key,
        reason: opened.reason,
        trigger,
      });
      return { state: "error", reason: opened.reason };
    }

    const partyApprovalIds: string[] = [];
    for (const ticket of proposal.parties) {
      const hash = createHash("sha256").update(`${ticket.key}:internal`).digest("hex");
      const partyClaim = await claimChannelClassifyProposal({ orgId, key: ticket.key, factsHash: hash });
      if (partyClaim.state !== "claimed") continue;
      if (!(await withinProposalBudget(orgId, trigger))) {
        await releaseChannelClassifyProposal({ orgId, key: ticket.key });
        break;
      }
      const identifier = String(ticket.args.identifier);
      const partySummary = await buildPartyUpsertCardSummaryJa(
        orgId,
        { kind: "slack_user", identifier, audience: "internal" },
        { requester: "system" }
      ).catch(() => `【自動提案・未反映】相手台帳 slack_user ${identifier} → internal`);
      const party = await openTicket({
        orgId,
        ticket,
        factsHash: hash,
        title: "相手台帳の提案（混在チャネル）",
        summary: partySummary,
        trigger,
        metadata: { partyProposal: { version: 1, kind: "slack_user", identifier, channelExternalId: facts.externalId, trigger } },
      });
      if (party.ok) partyApprovalIds.push(party.approval.id);
    }

    await audit(orgId, "channel_classify.proposed", `チャネル分類を提案（承認待ち・未反映）: ${surfaceLabel(facts.surface)} ${facts.externalId}`, {
      approvalId: opened.approval.id,
      partyApprovalIds,
      surface: facts.surface,
      externalId: facts.externalId,
      trigger,
      basis: proposal.suggestion.basis,
      always_human: true,
    });
    return { state: "created", approvalId: opened.approval.id, partyApprovalIds };
  } catch {
    return { state: "error", reason: "proposal_failed" };
  }
}
