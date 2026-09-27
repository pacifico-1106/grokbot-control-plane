/**
 * Recipient-based approval delivery routing.
 * P0 Item 4: Route approval cards to voters' bound identities or threads.
 *
 * Feature flag: APPROVAL_RECIPIENT_ROUTING (default OFF)
 *
 * Routing rules:
 * - Business-class tickets: deliver to stage voters' bound identities by DM,
 *   or to originating conversation thread when policy says thread
 * - Admin-class tickets: always go to org admin inbox (default channel),
 *   never to business approvers
 *
 * Security invariants:
 * - Never post approval cards to Slack Connect shared channels
 * - Never post to threads within shared channels
 * - Admin-class never routes to business voters
 */

import type { ApprovalRequest, Employee, NotificationProvider } from "@/lib/types";
import type { WorkflowProgressDisplay } from "@/lib/notify/slack";
import type { DeliveryRecipient, DeliveryResult } from "./delivery-adapter";
import { createDeliveryAdapter, hasDeliveryAdapter } from "./delivery-adapter";
import { isAdminClassApproval, ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { listVoterBindings, type VoterBinding } from "@/lib/approval-workflow/voter-binding";
import {
  getEnabledNotificationChannels,
  resolveEmployeeApprovalChannel,
  type NotificationChannelRuntime,
} from "@/lib/data/notification-channels";

import "./slack-delivery-adapter";
import "./telegram-delivery-adapter";
import "./line-delivery-adapter";

export function isRecipientRoutingEnabled(): boolean {
  const flag = (process.env.APPROVAL_RECIPIENT_ROUTING || "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "on" || flag === "enabled";
}

export interface RecipientRoutingInput {
  approval: ApprovalRequest;
  employee: Employee | null;
  workflow?: WorkflowProgressDisplay | null;
  stageVoterUserIds?: string[];
  notifyMouth?: "channel" | "thread" | "dm";
  threadTs?: string;
}

export interface RecipientRoutingResult {
  recipients: DeliveryRecipient[];
  deliveries: DeliveryResult[];
  fallbackToDefault: boolean;
  reason: string;
}

export async function routeApprovalToRecipients(
  input: RecipientRoutingInput
): Promise<RecipientRoutingResult> {
  if (!isRecipientRoutingEnabled()) {
    return {
      recipients: [],
      deliveries: [],
      fallbackToDefault: true,
      reason: "feature_flag_off",
    };
  }

  if (isAdminClassApproval(input.approval)) {
    return {
      recipients: [],
      deliveries: [],
      fallbackToDefault: true,
      reason: "admin_class_uses_default_channel",
    };
  }

  const defaultChannel = await resolveEmployeeApprovalChannel(
    input.approval.orgId,
    input.employee
  );

  if (!defaultChannel) {
    return {
      recipients: [],
      deliveries: [],
      fallbackToDefault: true,
      reason: "no_default_channel",
    };
  }

  if (input.notifyMouth === "thread" && input.threadTs) {
    const threadResult = await deliverToThread(input, defaultChannel);
    if (threadResult.ok) {
      return {
        recipients: threadResult.recipients,
        deliveries: threadResult.deliveries,
        fallbackToDefault: false,
        reason: "delivered_to_thread",
      };
    }
  }

  if (input.stageVoterUserIds && input.stageVoterUserIds.length > 0) {
    const dmResult = await deliverToVotersDm(input, defaultChannel);
    if (dmResult.ok && dmResult.deliveries.some((d) => d.ok)) {
      return {
        recipients: dmResult.recipients,
        deliveries: dmResult.deliveries,
        fallbackToDefault: false,
        reason: "delivered_to_voters_dm",
      };
    }
  }

  return {
    recipients: [],
    deliveries: [],
    fallbackToDefault: true,
    reason: "no_viable_recipients",
  };
}

async function deliverToThread(
  input: RecipientRoutingInput,
  defaultChannel: NotificationChannelRuntime
): Promise<{ ok: boolean; recipients: DeliveryRecipient[]; deliveries: DeliveryResult[] }> {
  const adapter = await createDeliveryAdapter(
    defaultChannel.provider,
    defaultChannel.id,
    input.approval.orgId
  );

  if (!adapter) {
    return { ok: false, recipients: [], deliveries: [] };
  }

  const sharedCheck = await adapter.isSharedChannel();
  if (sharedCheck.shared) {
    return { ok: false, recipients: [], deliveries: [] };
  }

  const recipient: DeliveryRecipient = {
    kind: "thread",
    provider: defaultChannel.provider,
    channelId: defaultChannel.id,
    threadTs: input.threadTs,
  };

  const result = await adapter.sendToThread({
    text: buildApprovalSummaryText(input.approval),
    threadTs: input.threadTs || "",
  });

  return {
    ok: result.ok,
    recipients: [recipient],
    deliveries: [result],
  };
}

async function deliverToVotersDm(
  input: RecipientRoutingInput,
  defaultChannel: NotificationChannelRuntime
): Promise<{ ok: boolean; recipients: DeliveryRecipient[]; deliveries: DeliveryResult[] }> {
  const bindings = await listVoterBindings({
    orgId: input.approval.orgId,
    channelKey: defaultChannel.id,
  });

  const activeBindings = bindings.filter((b) => b.status === "active");

  const voterBindings = activeBindings.filter((b) =>
    input.stageVoterUserIds?.includes(b.memberId)
  );

  if (voterBindings.length === 0) {
    return { ok: false, recipients: [], deliveries: [] };
  }

  const adapter = await createDeliveryAdapter(
    defaultChannel.provider,
    defaultChannel.id,
    input.approval.orgId
  );

  if (!adapter) {
    return { ok: false, recipients: [], deliveries: [] };
  }

  const recipients: DeliveryRecipient[] = [];
  const deliveries: DeliveryResult[] = [];

  for (const binding of voterBindings) {
    const recipient: DeliveryRecipient = {
      kind: "dm",
      provider: binding.provider,
      channelId: defaultChannel.id,
      externalUserId: binding.externalUserId,
    };

    const result = await adapter.sendDm(recipient, {
      text: buildApprovalSummaryText(input.approval),
    });

    recipients.push(recipient);
    deliveries.push(result);
  }

  return {
    ok: deliveries.some((d) => d.ok),
    recipients,
    deliveries,
  };
}

function buildApprovalSummaryText(approval: ApprovalRequest): string {
  return `承認依頼: ${approval.title}\nリスク: ${approval.risk}\n${approval.summary}`;
}

export async function checkSharedChannelDeliveryAllowed(
  provider: NotificationProvider,
  channelId: string,
  orgId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const adapter = await createDeliveryAdapter(provider, channelId, orgId);
  if (!adapter) {
    return { allowed: false, reason: "no_adapter" };
  }

  const sharedCheck = await adapter.isSharedChannel();
  if (sharedCheck.shared) {
    return { allowed: false, reason: sharedCheck.reason };
  }

  return { allowed: true };
}

export function validateDeliveryRecipient(
  recipient: DeliveryRecipient,
  approval: ApprovalRequest
): { valid: boolean; reason?: string } {
  if (isAdminClassApproval(approval)) {
    if (recipient.kind !== "channel") {
      return {
        valid: false,
        reason: "admin_class_must_use_channel",
      };
    }
  }

  return { valid: true };
}
