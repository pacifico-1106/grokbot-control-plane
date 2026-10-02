/**
 * P1 Channel Scope — Types (CS1 data layer)
 *
 * Per-AI-employee channel coverage. Design: channel-scope-design-20261002.md §2/§3.
 *
 * Feature flags (default OFF):
 * - P1_CHANNEL_SCOPE_ENABLED: master switch. OFF ⇒ always registered_only and callers
 *   must keep legacy behavior (decision.enforced === false).
 * - P1_CHANNEL_SCOPE_CONNECT_ENABLED: Slack Connect kill switch. OFF ⇒ includeSlackConnect
 *   is treated as false everywhere.
 *
 * Security invariants:
 * - Safe default is registered_only (never wider than today).
 * - includeSlackConnect is only meaningful with mode=all_joined (validate rejects otherwise).
 * - Automatic classification only ever makes a channel stricter (never → internal from shared).
 */
import type { ChannelClassification } from "@/lib/types";

export type ChannelScopeMode = "registered_only" | "all_joined";

export const CHANNEL_SCOPE_MODES: readonly ChannelScopeMode[] = ["registered_only", "all_joined"] as const;

/** Only Slack is supported in P1. */
export type ChannelScopeSurface = "slack";

export const CHANNEL_SCOPE_SURFACES: readonly ChannelScopeSurface[] = ["slack"] as const;

/** Egress handling on auto-joined Connect channels until a human confirms the classification. */
export type ChannelScopeConnectEgress = "needs_approval_until_confirmed" | "matrix";

export const CHANNEL_SCOPE_CONNECT_EGRESS: readonly ChannelScopeConnectEgress[] = [
  "needs_approval_until_confirmed",
  "matrix",
] as const;

export interface ChannelScopeConnectConfig {
  /** Default needs_approval_until_confirmed (fail-closed). */
  egress: ChannelScopeConnectEgress;
  /** Send an info card (no buttons) to the approver inbox on Connect invites. Default true. */
  notifyApproverOnInvite: boolean;
  /** Empty = any external team may be in scope (egress still gated). Non-empty = others are out_of_scope. */
  allowedExternalTeamIds: string[];
}

/** Policy JSON stored in orgs.channel_scope_policy and employees.channel_scope_override. */
export interface ChannelScopePolicy {
  version: 1;
  mode: ChannelScopeMode;
  includeSlackConnect: boolean;
  surfaces: ChannelScopeSurface[];
  connect: ChannelScopeConnectConfig;
  updatedAt?: string;
  /** e.g. "approval:<id>" */
  updatedBy?: string;
}

/** Which layer produced the effective policy. */
export type ChannelScopeSource = "employee" | "org" | "default";

export interface ChannelScopeFlags {
  enabled: boolean;
  connectEnabled: boolean;
}

export interface EffectiveChannelScope {
  /** Effective policy after flags are applied (connect kill switch etc.). */
  policy: ChannelScopePolicy;
  source: ChannelScopeSource;
  flags: ChannelScopeFlags;
  /** True when includeSlackConnect was requested by the stored policy but forced off. */
  connectSuppressed: boolean;
  /** True when a stored policy was present but invalid and the safe default was used. */
  invalidStoredPolicy: boolean;
}

/** org_channels.source */
export type OrgChannelSource = "manual" | "auto_join" | "egress_inspect" | "reconcile";

export const ORG_CHANNEL_SOURCES: readonly OrgChannelSource[] = [
  "manual",
  "auto_join",
  "egress_inspect",
  "reconcile",
] as const;

/** Channel row fields needed for scope decisions (org_channels + CS1 columns). */
export interface ChannelScopeChannel {
  externalId: string;
  classification: ChannelClassification;
  mixed: boolean;
  /** Missing (pre-migration row / legacy select) is treated as the column default 'manual'. */
  source?: OrgChannelSource | null;
  slackTeamId?: string | null;
  externalTeamIds?: string[] | null;
  humanConfirmedAt?: string | null;
  lastInspectedAt?: string | null;
}

export type MembershipVia = "user" | "bot";
export type MembershipState = "member" | "left" | "removed" | "out_of_scope";

export const MEMBERSHIP_VIAS: readonly MembershipVia[] = ["user", "bot"] as const;
export const MEMBERSHIP_STATES: readonly MembershipState[] = ["member", "left", "removed", "out_of_scope"] as const;

/** employee_channel_memberships row. */
export interface EmployeeChannelMembership {
  id: string;
  orgId: string;
  employeeId: string;
  surface: ChannelScopeSurface;
  externalId: string;
  via: MembershipVia;
  state: MembershipState;
  inviterSlackUserId: string | null;
  inviterTeamId: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  lastEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelScopeDecisionReason =
  | "flag_off_legacy"
  | "registered"
  | "not_registered"
  | "registered_unclassified"
  | "auto_not_confirmed"
  | "membership_left"
  | "not_member"
  | "joined_internal"
  | "joined_connect"
  | "connect_not_included"
  | "connect_team_not_allowed"
  | "classification_unknown"
  | "surface_not_in_scope"
  | "lookup_failed";

export interface ChannelScopeDecision {
  /**
   * false when P1_CHANNEL_SCOPE_ENABLED is OFF: callers MUST keep their legacy checks and
   * must not gate on inScope (byte-identical behavior).
   */
  enforced: boolean;
  inScope: boolean;
  reason: ChannelScopeDecisionReason;
  mode: ChannelScopeMode;
  source: ChannelScopeSource;
}

/** Subset of Slack conversations.info used for automatic classification (CS3). */
export interface SlackConversationInfoLike {
  is_ext_shared?: boolean | null;
  is_pending_ext_shared?: boolean | null;
  is_shared?: boolean | null;
  is_org_shared?: boolean | null;
  context_team_id?: string | null;
  connected_team_ids?: string[] | null;
  pending_connected_team_ids?: string[] | null;
}

export interface AutoClassification {
  classification: ChannelClassification;
  mixed: boolean;
  slackTeamId: string | null;
  externalTeamIds: string[];
  /** Short machine reason for audit. */
  basis:
    | "api_failed"
    | "ext_shared"
    | "pending_ext_shared"
    | "foreign_connected_team"
    | "org_shared_internal_teams"
    | "org_shared_unverified"
    | "home_team_internal"
    | "home_team_not_registered";
}
