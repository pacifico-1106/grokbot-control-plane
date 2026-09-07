/**
 * Channel-agnostic audience resolver (WHO).
 * Tool names (slack.post vs slack.post_external) are never the boundary.
 * Unknown / missing destination → external (fail-closed).
 * Mixed / shared Slack channel → S1 dual-audience: per-party resolution
 * with internal-facing vs external-facing signals.
 */

import {
  getOrgChannel,
  getOrgParty,
  upsertOrgChannel,
} from "@/lib/data/directory";
import { inspectSlackChannelExtShared } from "@/lib/slack/bot-token";
import type {
  Audience,
  ConversationContext,
  ConversationSurface,
  DualAudience,
  GatewayInvokeRequest,
  OrgPartyKind,
  PartyAudienceSignal,
} from "@/lib/types";

const SURFACES: ConversationSurface[] = ["slack", "line", "mail", "phone", "web"];

export function isConversationSurface(value: unknown): value is ConversationSurface {
  return typeof value === "string" && SURFACES.includes(value as ConversationSurface);
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstStr(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = str(value);
    if (found) return found;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Canonical thread id for Slack replies. Clients send several aliases
 * (slackThreadTs / thread_ts / threadTs); map them all onto threadId.
 * When no thread parent is present, fall back to the mention-source
 * message ts so a channel-level mention starts a thread under that message.
 */
export function resolveConversationThreadId(input: {
  conversation?: ConversationContext | Record<string, unknown> | null;
  args?: Record<string, unknown> | null;
  body?: Pick<GatewayInvokeRequest, "threadId"> | null;
}): string | undefined {
  const conv = asRecord(input.conversation);
  const args = asRecord(input.args);
  const body = input.body;
  return (
    firstStr(
      conv.threadId,
      conv.slackThreadTs,
      conv.thread_ts,
      conv.threadTs,
      body?.threadId,
      args.threadId,
      args.thread_id,
      args.slackThreadTs,
      args.thread_ts,
      args.threadTs
    ) ||
    firstStr(conv.messageTs, conv.slackTs, args.messageTs, args.slackTs)
  );
}

function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).trim().toLowerCase() || undefined;
}

function normalizeIdentifier(kind: OrgPartyKind, raw: string): string {
  const value = raw.trim();
  if (kind === "email_domain" || kind === "mail_address") return value.toLowerCase();
  if (kind === "phone") return value.replace(/[^\d+]/g, "") || value;
  return value;
}

export function conversationHasDestination(ctx: ConversationContext): boolean {
  return Boolean(
    ctx.slackChannelId ||
      ctx.slackUserId ||
      ctx.email ||
      ctx.phone ||
      ctx.lineId
  );
}

export function conversationHasNamedRecipients(ctx: ConversationContext): boolean {
  return Boolean(ctx.slackUserId || ctx.email || ctx.phone || ctx.lineId);
}

function inferSurface(body: GatewayInvokeRequest, args: Record<string, unknown>): ConversationSurface | undefined {
  const raw =
    body.conversation?.surface ||
    body.surface ||
    args.surface ||
    args.channelSurface;
  if (isConversationSurface(raw)) return raw;
  if (str(body.slackChannelId) || str(body.slackUserId) || str(args.slackChannelId) || str(args.channel)) {
    return "slack";
  }
  if (str(body.email) || str(args.email) || str(args.to) || str(args.recipient)) return "mail";
  if (str(body.lineId) || str(args.lineId)) return "line";
  if (str(body.phone) || str(args.phone)) return "phone";
  return undefined;
}

export function parseConversationContext(
  body: GatewayInvokeRequest,
  orgId: string
): ConversationContext | null {
  const args = asRecord(body.args);
  const conv = asRecord(body.conversation);
  const surface = inferSurface(body, args);
  if (!surface) return null;

  const email = str(conv.email) || str(body.email) || str(args.email) || str(args.to) || str(args.recipient);
  const slackChannelId =
    str(conv.slackChannelId) ||
    str(body.slackChannelId) ||
    str(args.slackChannelId) ||
    str(args.channelId) ||
    str(args.channel);
  const slackUserId =
    str(conv.slackUserId) || str(body.slackUserId) || str(args.slackUserId) || str(args.userId);
  const phone = str(conv.phone) || str(body.phone) || str(args.phone);
  const lineId = str(conv.lineId) || str(body.lineId) || str(args.lineId);
  const threadId = resolveConversationThreadId({ conversation: conv, args, body });

  return {
    surface,
    orgId: str(conv.orgId) || orgId,
    threadId,
    email,
    slackChannelId,
    slackUserId,
    phone,
    lineId,
  };
}

function failClosed(signals: Audience[]): Audience {
  if (!signals.length) return "unknown";
  if (signals.some((item) => item !== "internal")) return "external";
  return "internal";
}

/**
 * Compute dual-audience from party signals for mixed channels.
 * - internalFacing: strictest of internal-only parties (for internal-safe routing)
 * - externalFacing: always external when any external/unknown party present
 */
function computeDualAudience(
  partySignals: PartyAudienceSignal[],
  channelMixed: boolean
): DualAudience {
  const internalParties = partySignals.filter(
    (item) => item.audience === "internal" && item.resolved
  );
  const externalOrUnknownParties = partySignals.filter(
    (item) => item.audience !== "internal" || !item.resolved
  );

  const hasInternalParty = internalParties.length > 0;
  const hasExternalParty = externalOrUnknownParties.length > 0;

  const internalFacing: "internal" | "external" = hasInternalParty && !hasExternalParty
    ? "internal"
    : "external";

  const externalFacing: "internal" | "external" = hasExternalParty
    ? "external"
    : hasInternalParty
      ? "internal"
      : "external";

  return {
    internalFacing,
    externalFacing,
    channelMixed,
    partySignals,
    hasInternalParty,
    hasExternalParty,
  };
}

export async function resolveAudience(
  ctx: ConversationContext | null,
  opts?: { requireDestination?: boolean }
): Promise<{
  audience: Audience;
  effectiveAudience: "internal" | "external";
  namedRecipients: boolean;
  destinationMissing: boolean;
  /** S1: dual-audience resolution for mixed/Connect channels. */
  dualAudience: DualAudience | null;
}> {
  const emptyDual: DualAudience = {
    internalFacing: "external",
    externalFacing: "external",
    channelMixed: false,
    partySignals: [],
    hasInternalParty: false,
    hasExternalParty: false,
  };

  if (!ctx) {
    return {
      audience: "unknown",
      effectiveAudience: "external",
      namedRecipients: false,
      destinationMissing: true,
      dualAudience: emptyDual,
    };
  }

  const destinationMissing = !conversationHasDestination(ctx);
  if (opts?.requireDestination && destinationMissing) {
    return {
      audience: "unknown",
      effectiveAudience: "external",
      namedRecipients: false,
      destinationMissing: true,
      dualAudience: emptyDual,
    };
  }

  const signals: Audience[] = [];
  const partySignals: PartyAudienceSignal[] = [];
  let channelMixed = false;
  let channelClassifiedInternal = false;

  if (ctx.slackChannelId) {
    const channel = await getOrgChannel(ctx.orgId, ctx.surface, ctx.slackChannelId);
    if (!channel) {
      const party = await getOrgParty(ctx.orgId, "slack_channel", normalizeIdentifier("slack_channel", ctx.slackChannelId));
      const aud = party?.audience ?? "unknown";
      signals.push(aud);
      partySignals.push({
        kind: "channel",
        identifier: ctx.slackChannelId,
        audience: aud,
        resolved: !!party,
      });
    } else if (channel.mixed || channel.classification !== "internal") {
      channelMixed = true;
      partySignals.push({
        kind: "channel",
        identifier: ctx.slackChannelId,
        audience: channel.classification === "shared_external" ? "external" : "unknown",
        resolved: true,
      });
    } else {
      channelClassifiedInternal = true;
      signals.push("internal");
      partySignals.push({
        kind: "channel",
        identifier: ctx.slackChannelId,
        audience: "internal",
        resolved: true,
      });
    }
  }

  const partyLookups: Array<{ kind: OrgPartyKind; identifier?: string }> = [
    { kind: "slack_user", identifier: ctx.slackUserId },
    { kind: "mail_address", identifier: ctx.email ? ctx.email.toLowerCase() : undefined },
    { kind: "phone", identifier: ctx.phone ? normalizeIdentifier("phone", ctx.phone) : undefined },
    { kind: "line", identifier: ctx.lineId },
  ];
  for (const item of partyLookups) {
    if (!item.identifier) continue;
    const party = await getOrgParty(ctx.orgId, item.kind, item.identifier);
    if (party) {
      signals.push(party.audience);
      partySignals.push({
        kind: item.kind,
        identifier: item.identifier,
        audience: party.audience,
        resolved: true,
      });
      continue;
    }
    if (item.kind === "mail_address") {
      const domain = emailDomain(item.identifier);
      if (domain) {
        const domainParty = await getOrgParty(ctx.orgId, "email_domain", domain);
        const aud = domainParty?.audience ?? "unknown";
        signals.push(aud);
        partySignals.push({
          kind: item.kind,
          identifier: item.identifier,
          audience: aud,
          resolved: !!domainParty,
        });
        continue;
      }
    }
    signals.push("unknown");
    partySignals.push({
      kind: item.kind,
      identifier: item.identifier,
      audience: "unknown",
      resolved: false,
    });
  }

  if (ctx.slackChannelId) {
    const extShared = await inspectSlackChannelExtShared(ctx.orgId, ctx.slackChannelId);
    if (extShared === true) {
      channelMixed = true;
      const existingChannelSignal = partySignals.find(
        (item) => item.kind === "channel" && item.identifier === ctx.slackChannelId
      );
      if (existingChannelSignal) {
        existingChannelSignal.audience = "external";
        existingChannelSignal.resolved = true;
      } else {
        partySignals.push({
          kind: "channel",
          identifier: ctx.slackChannelId,
          audience: "external",
          resolved: true,
        });
      }
      try {
        await upsertOrgChannel({
          orgId: ctx.orgId,
          surface: "slack",
          externalId: ctx.slackChannelId,
          classification: "shared_external",
          mixed: true,
          skipInspect: true,
        });
      } catch {
        /* ledger update is best-effort; audience is already external */
      }
    }
  }

  const nonChannelPartySignals = partySignals.filter((item) => item.kind !== "channel");

  const dualAudience = computeDualAudience(
    nonChannelPartySignals.length > 0 ? nonChannelPartySignals : partySignals,
    channelMixed
  );

  let audience: Audience;
  if (channelClassifiedInternal && !channelMixed) {
    audience = failClosed(signals);
  } else if (channelMixed) {
    const allSignals = nonChannelPartySignals.map((item) => item.audience);
    if (allSignals.length === 0) {
      audience = "external";
    } else {
      audience = failClosed(allSignals);
    }
    if (audience === "internal") {
      audience = "external";
    }
  } else {
    audience = failClosed(signals);
  }

  return {
    audience,
    effectiveAudience: audience === "internal" ? "internal" : "external",
    namedRecipients: conversationHasNamedRecipients(ctx),
    destinationMissing,
    dualAudience,
  };
}

export function effectiveAudienceOf(audience: Audience): "internal" | "external" {
  return audience === "internal" ? "internal" : "external";
}
