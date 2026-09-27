/**
 * Channel-agnostic approval delivery adapter interface.
 * P0 Item 4: Abstract delivery operations for Slack, Telegram, LINE, and future providers.
 *
 * Recipient-based routing:
 * - Business-class tickets: deliver to voters' bound identities by DM
 * - Admin-class tickets: always go to org admin inbox (default channel)
 * - Thread notifications: deliver to originating conversation thread
 */

import type { ApprovalRequest, Employee, NotificationProvider } from "@/lib/types";
import type { WorkflowProgressDisplay } from "@/lib/notify/slack";

export type DeliveryRecipientKind = "channel" | "dm" | "thread";

export interface DeliveryRecipient {
  kind: DeliveryRecipientKind;
  provider: NotificationProvider;
  channelId: string;
  externalUserId?: string;
  threadTs?: string;
}

export interface DeliveryResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  skipped?: boolean;
  recipient?: DeliveryRecipient;
}

export interface SendCardOptions {
  approval: ApprovalRequest;
  employee: Employee | null;
  workflow?: WorkflowProgressDisplay | null;
}

export interface UpdateProgressOptions {
  approval: ApprovalRequest;
  employee: Employee | null;
  workflow: WorkflowProgressDisplay;
}

export interface SendDecisionOptions {
  approval: ApprovalRequest;
  decision: "approved" | "rejected" | "revision_requested";
  actor: string;
}

export interface SendDmOptions {
  text: string;
  blocks?: unknown[];
}

export interface SendToThreadOptions {
  text: string;
  threadTs: string;
  blocks?: unknown[];
}

export interface InteractionNormalizeInput {
  rawPayload: unknown;
  provider: NotificationProvider;
}

export interface NormalizedInteraction {
  userId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  actionId: string;
  actionValue: string;
  responseUrl: string;
}

/**
 * Abstract delivery adapter interface.
 * Each provider (Slack, Telegram, LINE) implements this interface.
 */
export interface ApprovalDeliveryAdapter {
  readonly provider: NotificationProvider;
  readonly channelId: string;
  readonly orgId: string;

  sendCard(options: SendCardOptions): Promise<DeliveryResult>;

  updateProgress(options: UpdateProgressOptions): Promise<DeliveryResult>;

  sendDecision(options: SendDecisionOptions): Promise<DeliveryResult>;

  sendDm(recipient: DeliveryRecipient, options: SendDmOptions): Promise<DeliveryResult>;

  sendToThread(options: SendToThreadOptions): Promise<DeliveryResult>;

  normalizeInteraction(input: InteractionNormalizeInput): NormalizedInteraction | null;

  canDeliverToRecipient(recipient: DeliveryRecipient): Promise<boolean>;

  isSharedChannel(): Promise<{ shared: boolean; reason?: string }>;
}

/**
 * Factory function type for creating delivery adapters.
 */
export type DeliveryAdapterFactory = (
  channelId: string,
  orgId: string
) => Promise<ApprovalDeliveryAdapter | null>;

const adapterFactories = new Map<NotificationProvider, DeliveryAdapterFactory>();

export function registerDeliveryAdapter(
  provider: NotificationProvider,
  factory: DeliveryAdapterFactory
): void {
  adapterFactories.set(provider, factory);
}

export async function createDeliveryAdapter(
  provider: NotificationProvider,
  channelId: string,
  orgId: string
): Promise<ApprovalDeliveryAdapter | null> {
  const factory = adapterFactories.get(provider);
  if (!factory) return null;
  return factory(channelId, orgId);
}

export function hasDeliveryAdapter(provider: NotificationProvider): boolean {
  return adapterFactories.has(provider);
}
