/**
 * Channel-agnostic audience resolver (WHO).
 * Tool names (slack.post vs slack.post_external) are never the boundary.
 * Unknown / missing destination → external (fail-closed).
 * Mixed / shared Slack channel → external for egress.
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
  GatewayInvokeRequest,
  OrgPartyKind,
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
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
  const conv = body.conversation && typeof body.conversation === "object" ? body.conversation : {};
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
  const threadId = str(conv.threadId) || str(body.threadId) || str(args.threadId) || str(args.thread_id);

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

export async function resolveAudience(
  ctx: ConversationContext | null,
  opts?: { requireDestination?: boolean }
): Promise<{
  audience: Audience;
  effectiveAudience: "internal" | "external";
  namedRecipients: boolean;
  destinationMissing: boolean;
}> {
  if (!ctx) {
    return {
      audience: "unknown",
      effectiveAudience: "external",
      namedRecipients: false,
      destinationMissing: true,
    };
  }

  const destinationMissing = !conversationHasDestination(ctx);
  if (opts?.requireDestination && destinationMissing) {
    return {
      audience: "unknown",
      effectiveAudience: "external",
      namedRecipients: false,
      destinationMissing: true,
    };
  }

  const signals: Audience[] = [];

  if (ctx.slackChannelId) {
    const channel = await getOrgChannel(ctx.orgId, ctx.surface, ctx.slackChannelId);
    if (!channel) {
      const party = await getOrgParty(ctx.orgId, "slack_channel", normalizeIdentifier("slack_channel", ctx.slackChannelId));
      signals.push(party?.audience ?? "unknown");
    } else if (channel.mixed || channel.classification !== "internal") {
      signals.push("external");
    } else {
      signals.push("internal");
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
      continue;
    }
    if (item.kind === "mail_address") {
      const domain = emailDomain(item.identifier);
      if (domain) {
        const domainParty = await getOrgParty(ctx.orgId, "email_domain", domain);
        signals.push(domainParty?.audience ?? "unknown");
        continue;
      }
    }
    signals.push("unknown");
  }

  if (ctx.slackChannelId) {
    const extShared = await inspectSlackChannelExtShared(ctx.orgId, ctx.slackChannelId);
    if (extShared === true) {
      signals.push("external");
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

  const audience = failClosed(signals);
  return {
    audience,
    effectiveAudience: audience === "internal" ? "internal" : "external",
    namedRecipients: conversationHasNamedRecipients(ctx),
    destinationMissing,
  };
}

export function effectiveAudienceOf(audience: Audience): "internal" | "external" {
  return audience === "internal" ? "internal" : "external";
}
