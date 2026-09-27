/**
 * Telegram implementation of ApprovalDeliveryAdapter (stub).
 * P0 Item 4: Stub implementation - full Telegram adapter to be implemented in future.
 *
 * TODO: Implement full Telegram delivery adapter when needed.
 */

import type { NotificationProvider } from "@/lib/types";
import type {
  ApprovalDeliveryAdapter,
  DeliveryRecipient,
  DeliveryResult,
  InteractionNormalizeInput,
  NormalizedInteraction,
  SendCardOptions,
  SendDecisionOptions,
  SendDmOptions,
  SendToThreadOptions,
  UpdateProgressOptions,
} from "./delivery-adapter";
import { registerDeliveryAdapter } from "./delivery-adapter";

export class TelegramDeliveryAdapter implements ApprovalDeliveryAdapter {
  readonly provider: NotificationProvider = "telegram";
  readonly channelId: string;
  readonly orgId: string;

  constructor(channelId: string, orgId: string) {
    this.channelId = channelId;
    this.orgId = orgId;
  }

  async sendCard(_options: SendCardOptions): Promise<DeliveryResult> {
    return { ok: false, error: "telegram_adapter_not_implemented", skipped: true };
  }

  async updateProgress(_options: UpdateProgressOptions): Promise<DeliveryResult> {
    return { ok: false, error: "telegram_adapter_not_implemented", skipped: true };
  }

  async sendDecision(_options: SendDecisionOptions): Promise<DeliveryResult> {
    return { ok: false, error: "telegram_adapter_not_implemented", skipped: true };
  }

  async sendDm(_recipient: DeliveryRecipient, _options: SendDmOptions): Promise<DeliveryResult> {
    return { ok: false, error: "telegram_adapter_not_implemented", skipped: true };
  }

  async sendToThread(_options: SendToThreadOptions): Promise<DeliveryResult> {
    return { ok: false, error: "telegram_adapter_not_implemented", skipped: true };
  }

  normalizeInteraction(_input: InteractionNormalizeInput): NormalizedInteraction | null {
    return null;
  }

  async canDeliverToRecipient(_recipient: DeliveryRecipient): Promise<boolean> {
    return false;
  }

  async isSharedChannel(): Promise<{ shared: boolean; reason?: string }> {
    return { shared: false };
  }
}

async function createTelegramDeliveryAdapter(
  channelId: string,
  orgId: string
): Promise<TelegramDeliveryAdapter | null> {
  return new TelegramDeliveryAdapter(channelId, orgId);
}

registerDeliveryAdapter("telegram", createTelegramDeliveryAdapter);
