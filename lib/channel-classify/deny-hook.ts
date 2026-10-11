/**
 * PR-B: what happens next when the gateway denies a post because the channel
 * is treated as external.
 *
 * - egressDenyNextStep(): always (no flag) — a machine-readable nextStep on
 *   the existing 403. Informational only; the deny itself is unchanged.
 *   (follow-up N2) The classification=internal example is offered ONLY for a
 *   channel the org has not registered (or registered as unknown, not mixed).
 *   A channel registered as shared_external / mixed (or via an external
 *   party) gets its own wording pointing to channels.list — it cannot become
 *   internal. Lookup is scoped to the caller's org; no org / lookup error →
 *   neutral wording without the internal example.
 * - onEgressDenied(): only for external_confidential_denied in a channel the
 *   ledger does not know. Opens a classification proposal
 *   (CHANNEL_CLASSIFY_PROPOSALS_ENABLED) and sends a stuck notice
 *   (CHANNEL_STUCK_NOTIFY_ENABLED). Bounded, never throws, never sees the body.
 */
import { isChannelClassifyProposalsEnabled, isChannelStuckNotifyEnabled } from "@/lib/channel-classify/flags";
import { classifyExample, surfaceLabel, unverifiedFacts, type ChannelRef, type ProposalState } from "@/lib/channel-classify/core";
import { factsForSignal } from "@/lib/channel-classify/join";
import { isChannelRegistered, proposeChannelClassification } from "@/lib/channel-classify/proposals";
import { getOrgChannel, getOrgParty } from "@/lib/data/directory";
import { notifyChannelStuck } from "@/lib/channel-classify/stuck-notify";
import type { GatewayInvokeRequest } from "@/lib/types";

const ID_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;
export const DENY_HOOK_TIMEOUT_MS = 6_000;

/** Reasons where "the channel is treated as external" is the cause. */
export const EXTERNAL_TREATED_DENY_REASONS = new Set([
  "external_confidential_denied",
  "external_internal_source_denied",
  "external_verbatim_denied",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

export function channelRefFromInvokeBody(body: GatewayInvokeRequest | null | undefined): ChannelRef | null {
  if (!body) return null;
  const conv = (body.conversation ?? {}) as Record<string, unknown>;
  const args = (body.args ?? {}) as Record<string, unknown>;
  const surface = str(conv.surface) || str(body.surface);
  const pick = (value: string, s: ChannelRef["surface"]): ChannelRef | null => (value && ID_RE.test(value) ? { surface: s, externalId: value } : null);
  if (surface === "line") return pick(str(conv.lineId) || str(body.lineId), "line");
  if (surface === "telegram" || str(conv.telegramChatId) || str(args.telegramChatId)) {
    return pick(str(conv.telegramChatId) || str(args.telegramChatId), "telegram");
  }
  if (!surface || surface === "slack") {
    const slack = str(conv.slackChannelId) || str(body.slackChannelId) || str(args.slackChannelId) || str(args.channel);
    if (slack && /^[CGD][A-Z0-9]{2,30}$/.test(slack)) return { surface: "slack", externalId: slack };
  }
  return null;
}

export type EgressDenyNextStep = {
  tool: "channels.classify" | "channels.list";
  surface: ChannelRef["surface"];
  externalId: string;
  reason: string;
  example: { name: string; arguments: Record<string, unknown> };
  /** Set when the org's ledger already has this channel (no internal example then). */
  registered?: { classification: string; mixed: boolean; via: "channel" | "party" };
  messageJa: string;
};

type Registration =
  | { state: "unregistered" }
  | { state: "registered"; classification: string; mixed: boolean; via: "channel" | "party" }
  | { state: "unknown" };

async function registrationOf(orgId: string, ref: ChannelRef): Promise<Registration> {
  if (!orgId) return { state: "unknown" };
  try {
    const channel = await getOrgChannel(orgId, ref.surface, ref.externalId);
    if (channel) return { state: "registered", classification: channel.classification, mixed: channel.mixed === true, via: "channel" };
    const partyKind = ref.surface === "slack" ? "slack_channel" : ref.surface === "line" ? "line" : null;
    if (partyKind) {
      const party = await getOrgParty(orgId, partyKind, ref.externalId);
      if (party) {
        return { state: "registered", classification: party.audience === "internal" ? "internal" : "shared_external", mixed: false, via: "party" };
      }
    }
    return { state: "unregistered" };
  } catch {
    return { state: "unknown" };
  }
}

export async function egressDenyNextStep(
  body: GatewayInvokeRequest | null | undefined,
  egress: { decision?: string; reason?: string; audience?: string } | null | undefined,
  orgId: string
): Promise<EgressDenyNextStep | null> {
  const reason = egress?.reason || "";
  if (!EXTERNAL_TREATED_DENY_REASONS.has(reason)) return null;
  const ref = channelRefFromInvokeBody(body);
  if (!ref || (ref.surface === "slack" && ref.externalId.startsWith("D"))) return null;
  const where = `${surfaceLabel(ref.surface)} ${ref.externalId}`;
  const listExample = { name: "channels.list", arguments: { surface: ref.surface } };
  const reg = await registrationOf(orgId, ref);
  if (reg.state === "unregistered" || (reg.state === "registered" && reg.via === "channel" && reg.classification === "unknown" && !reg.mixed)) {
    return {
      tool: "channels.classify",
      surface: ref.surface,
      externalId: ref.externalId,
      reason,
      example: classifyExample(ref),
      messageJa:
        `このチャネル（${where}）は社外扱いのため拒否されました。` +
        `社内だけのチャネルなら、管理エージェントで channels.classify（surface=${ref.surface}, externalId=${ref.externalId}, classification=internal）を依頼し、承認窓口で承認してください。` +
        `社外と共有している場合は shared_external（mixed）のままにしてください。`,
    };
  }
  if (reg.state === "registered") {
    const external = reg.mixed || reg.classification === "shared_external";
    return {
      tool: "channels.list",
      surface: ref.surface,
      externalId: ref.externalId,
      reason,
      example: listExample,
      registered: { classification: reg.classification, mixed: reg.mixed, via: reg.via },
      messageJa: external
        ? `このチャネル（${where}）は社外共有（shared_external${reg.mixed ? "・混在" : ""}）として登録済みのため、社外向けの基準で拒否されました。` +
          `登録済みの社外共有チャネルは internal に変更できません。社内向けの内容は社内チャネルで送るか、社外に出してよい内容に絞ってください。` +
          `登録内容は管理エージェントの channels.list で確認できます。`
        : `このチャネル（${where}）は台帳に ${reg.classification} として登録済みですが、宛先・相手の判定で社外扱いになったため拒否されました。` +
          `管理エージェントの channels.list と parties.list で登録内容を確認してください。`,
    };
  }
  return {
    tool: "channels.list",
    surface: ref.surface,
    externalId: ref.externalId,
    reason,
    example: listExample,
    messageJa:
      `このチャネル（${where}）は社外扱いのため拒否されました。` +
      `管理エージェントの channels.list で登録状態を確認してください（未登録なら channels.classify で分類を依頼できます）。`,
  };
}

async function run(input: {
  orgId: string;
  employee: { id?: string; approvalChannelId?: string | null } | null | undefined;
  body: GatewayInvokeRequest;
  egress: { reason?: string };
}): Promise<void> {
  const ref = channelRefFromInvokeBody(input.body);
  if (!ref || (ref.surface === "slack" && ref.externalId.startsWith("D"))) return;
  if (await isChannelRegistered(input.orgId, ref)) return;
  let approvalId: string | undefined;
  let proposalState: ProposalState = "not_proposed";
  if (isChannelClassifyProposalsEnabled()) {
    const facts = await factsForSignal({ orgId: input.orgId, ...ref, trigger: "egress_denied" }).catch(() => unverifiedFacts(ref));
    const outcome = await proposeChannelClassification({ orgId: input.orgId, facts, trigger: "egress_denied" });
    approvalId = outcome.approvalId;
    proposalState =
      outcome.state === "created" || outcome.state === "pending" || outcome.state === "decided"
        ? outcome.state
        : outcome.state === "error"
          ? "error"
          : "not_proposed";
  }
  if (!isChannelStuckNotifyEnabled()) return;
  await notifyChannelStuck({
    orgId: input.orgId,
    kind: "unregistered_channel_denied",
    ref,
    reason: input.egress.reason || "external_confidential_denied",
    approvalId,
    proposalState,
    employee: { approvalChannelId: input.employee?.approvalChannelId ?? null },
  });
}

export async function onEgressDenied(input: {
  orgId: string;
  employee: { id?: string; approvalChannelId?: string | null } | null | undefined;
  body: GatewayInvokeRequest;
  egress: { decision?: string; reason?: string; audience?: string };
}): Promise<void> {
  if (input.egress?.reason !== "external_confidential_denied") return;
  if (!isChannelClassifyProposalsEnabled() && !isChannelStuckNotifyEnabled()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(input).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DENY_HOOK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // never throws: the deny response is unchanged
  } finally {
    if (timer) clearTimeout(timer);
  }
}
