/**
 * P0-RP: Reply recipient validation.
 *
 * Validates who may be replied to based on:
 * - Employee's allowed audience (internal/external)
 * - Channel classification (internal/shared_external)
 * - Explicit party registrations
 * - Feature flag control
 *
 * Security invariants:
 * - Fail-closed when destination is unclear (no silent external send)
 * - Approval class for reply/send = business (not admin)
 * - Unknown recipients are treated as external
 */

import type {
  Audience,
  ConversationContext,
  ConversationSurface,
  Employee,
  ReplyRecipientValidation,
} from "@/lib/types";
import { isReplyPolicyEnhancedEnabled } from "@/lib/feature-flags";
import { BUSINESS_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { getOrgPartyByIdentifier } from "@/lib/data/directory";
import { getOrgChannel } from "@/lib/data/directory";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";

export type ReplyDestinationChoice = "channel" | "thread" | "dm";

export interface ReplyDestinationDecision {
  choice: ReplyDestinationChoice;
  threadTs?: string;
  dmUserId?: string;
  failClosed: boolean;
  reason: string;
}

export interface ValidateReplyRecipientInput {
  orgId: string;
  employee: Employee | null;
  context: Partial<ConversationContext>;
  recipientIdentifier?: string;
  recipientKind?: "slack_user" | "email_domain" | "phone" | "line";
}

export async function validateReplyRecipient(
  input: ValidateReplyRecipientInput
): Promise<ReplyRecipientValidation> {
  if (!isReplyPolicyEnhancedEnabled()) {
    return {
      status: "allowed",
      audience: "unknown",
      reason: "feature_flag_off",
      approvalClass: BUSINESS_AUDIT_CLASS,
      failClosed: false,
    };
  }

  const { orgId, employee, context, recipientIdentifier, recipientKind } = input;

  let resolvedAudience: Audience = "unknown";

  if (context.slackChannelId) {
    const channel = await getOrgChannel(orgId, "slack", context.slackChannelId);
    if (channel) {
      if (channel.classification === "internal" && !channel.mixed) {
        resolvedAudience = "internal";
      } else if (channel.classification === "shared_external" || channel.mixed) {
        resolvedAudience = await resolvePartyAudience(orgId, context, recipientIdentifier, recipientKind);
      }
    }
  }

  if (resolvedAudience === "unknown" && recipientIdentifier && recipientKind) {
    const party = await getOrgPartyByIdentifier(orgId, recipientKind, recipientIdentifier);
    if (party) {
      resolvedAudience = party.audience;
    } else {
      const rule = await getOrgInternalAudienceRule(orgId);
      if (rule) {
        if (recipientKind === "email_domain" && rule.emailDomains.includes(recipientIdentifier)) {
          resolvedAudience = "internal";
        } else if (recipientKind === "slack_user" && context.slackTeamId && rule.autoSlackTeamInternal) {
          if (rule.slackTeamIds.includes(context.slackTeamId)) {
            resolvedAudience = "internal";
          }
        }
      }
    }
  }

  if (resolvedAudience === "unknown") {
    return {
      status: "needs_approval",
      audience: "external",
      reason: "fail_closed_unknown_recipient",
      approvalClass: BUSINESS_AUDIT_CLASS,
      failClosed: true,
    };
  }

  const employeeAudience = getEmployeeAllowedAudience(employee);

  if (resolvedAudience === "external" && employeeAudience === "internal") {
    return {
      status: "needs_approval",
      audience: "external",
      reason: "external_recipient_needs_approval",
      approvalClass: BUSINESS_AUDIT_CLASS,
      failClosed: false,
    };
  }

  return {
    status: "allowed",
    audience: resolvedAudience,
    reason: "recipient_validated",
    approvalClass: BUSINESS_AUDIT_CLASS,
    failClosed: false,
  };
}

async function resolvePartyAudience(
  orgId: string,
  context: Partial<ConversationContext>,
  recipientIdentifier?: string,
  recipientKind?: string
): Promise<Audience> {
  if (!recipientIdentifier || !recipientKind) {
    return "unknown";
  }

  const party = await getOrgPartyByIdentifier(
    orgId,
    recipientKind as "slack_user" | "email_domain" | "phone" | "line",
    recipientIdentifier
  );

  if (party) {
    return party.audience;
  }

  const rule = await getOrgInternalAudienceRule(orgId);
  if (rule) {
    if (recipientKind === "slack_user" && context.slackTeamId && rule.autoSlackTeamInternal) {
      if (rule.slackTeamIds.includes(context.slackTeamId)) {
        return "internal";
      }
    }
  }

  return "unknown";
}

function getEmployeeAllowedAudience(employee: Employee | null): "internal" | "external" | "any" {
  if (!employee) {
    return "internal";
  }

  const hasExternalScope = employee.scopes.some((scope) =>
    ["mail:send", "slack:post_external", "sns:publish", "drive:share_external"].includes(scope)
  );

  return hasExternalScope ? "any" : "internal";
}

export interface DecideReplyDestinationInput {
  orgId: string;
  context: Partial<ConversationContext>;
  surface: ConversationSurface;
  preferThread: boolean;
}

export async function decideReplyDestination(
  input: DecideReplyDestinationInput
): Promise<ReplyDestinationDecision> {
  if (!isReplyPolicyEnhancedEnabled()) {
    return {
      choice: "channel",
      failClosed: false,
      reason: "feature_flag_off",
    };
  }

  const { context, preferThread } = input;

  const threadTs = context.slackThreadTs || context.thread_ts || context.threadTs;

  if (preferThread && threadTs) {
    return {
      choice: "thread",
      threadTs,
      failClosed: false,
      reason: "prefer_thread_with_existing_thread",
    };
  }

  const mentionTs = context.ts || context.messageTs || context.slackTs;
  if (preferThread && mentionTs && !threadTs) {
    return {
      choice: "thread",
      threadTs: mentionTs,
      failClosed: false,
      reason: "prefer_thread_start_from_mention",
    };
  }

  if (context.slackUserId && !context.slackChannelId) {
    return {
      choice: "dm",
      dmUserId: context.slackUserId,
      failClosed: false,
      reason: "dm_context",
    };
  }

  if (!context.slackChannelId && !context.email && !context.lineId) {
    return {
      choice: "channel",
      failClosed: true,
      reason: "fail_closed_no_destination",
    };
  }

  return {
    choice: "channel",
    failClosed: false,
    reason: "default_channel",
  };
}

export function getReplyApprovalClass(): "business" {
  return BUSINESS_AUDIT_CLASS;
}

export function isReplyFailClosed(
  recipientValidation: ReplyRecipientValidation,
  destinationDecision: ReplyDestinationDecision
): boolean {
  return recipientValidation.failClosed || destinationDecision.failClosed;
}
