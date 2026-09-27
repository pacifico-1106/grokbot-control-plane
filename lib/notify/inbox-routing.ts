/**
 * P0-IN: Inbox routing for AI employee inbound requests.
 *
 * Routes AI employee's approval-needed items to the responsible human via:
 * - Slack DM (primary path for P0)
 * - LINE DM (seam only, not enabled until P1)
 *
 * Security invariants:
 * - Slack Connect shared channels are never used for approval delivery
 * - Cross-org routing prohibited
 * - Admin-class approvals always use default org inbox (not DM)
 * - Fail-closed when destination is unclear
 */

import type { ApprovalRequest, Employee, NotificationProvider } from "@/lib/types";
import type { WorkflowProgressDisplay } from "@/lib/notify/slack";
import type { DeliveryRecipient, DeliveryResult } from "./delivery-adapter";
import { createDeliveryAdapter, hasDeliveryAdapter } from "./delivery-adapter";
import { isAdminClassApproval, BUSINESS_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { listVoterBindings } from "@/lib/approval-workflow/voter-binding";
import { getIdentityBinding } from "@/lib/employees/employee-identity";
import {
  getEnabledNotificationChannels,
  resolveEmployeeApprovalChannel,
  type NotificationChannelRuntime,
} from "@/lib/data/notification-channels";
import { isInboxRoutingEnabled } from "@/lib/feature-flags";

import "./slack-delivery-adapter";
import "./telegram-delivery-adapter";
import "./line-delivery-adapter";

export type InboxRoutingSurface = "slack_dm" | "line_dm" | "channel";

export interface InboxRoutingInput {
  approval: ApprovalRequest;
  employee: Employee | null;
  workflow?: WorkflowProgressDisplay | null;
  stageVoterUserIds?: string[];
}

export interface InboxRoutingResult {
  recipients: DeliveryRecipient[];
  deliveries: DeliveryResult[];
  fallbackToDefault: boolean;
  reason: string;
  surface: InboxRoutingSurface;
}

export async function routeInboxToResponsibleHuman(
  input: InboxRoutingInput
): Promise<InboxRoutingResult> {
  if (!isInboxRoutingEnabled()) {
    return {
      recipients: [],
      deliveries: [],
      fallbackToDefault: true,
      reason: "feature_flag_off",
      surface: "channel",
    };
  }

  if (isAdminClassApproval(input.approval)) {
    return {
      recipients: [],
      deliveries: [],
      fallbackToDefault: true,
      reason: "admin_class_uses_default_channel",
      surface: "channel",
    };
  }

  const identityBinding = input.employee
    ? await getIdentityBinding(input.approval.orgId, input.employee.id)
    : null;

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
      surface: "channel",
    };
  }

  if (identityBinding && identityBinding.status === "active") {
    const dmResult = await deliverToResponsibleHumanDm(
      input,
      defaultChannel,
      identityBinding.responsibleMemberId
    );
    if (dmResult.ok && dmResult.deliveries.some((d) => d.ok)) {
      return {
        recipients: dmResult.recipients,
        deliveries: dmResult.deliveries,
        fallbackToDefault: false,
        reason: "delivered_to_responsible_human_dm",
        surface: "slack_dm",
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
        surface: "slack_dm",
      };
    }
  }

  return {
    recipients: [],
    deliveries: [],
    fallbackToDefault: true,
    reason: "no_viable_dm_recipients",
    surface: "channel",
  };
}

async function deliverToResponsibleHumanDm(
  input: InboxRoutingInput,
  defaultChannel: NotificationChannelRuntime,
  responsibleMemberId: string
): Promise<{ ok: boolean; recipients: DeliveryRecipient[]; deliveries: DeliveryResult[] }> {
  const bindings = await listVoterBindings({
    orgId: input.approval.orgId,
    channelKey: defaultChannel.id,
    memberId: responsibleMemberId,
  });

  const activeBindings = bindings.filter((b) => b.status === "active");

  if (activeBindings.length === 0) {
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

  for (const binding of activeBindings) {
    if (binding.provider !== "slack") {
      continue;
    }

    const sharedCheck = await adapter.isSharedChannel();
    if (sharedCheck.shared) {
      console.warn("inbox_routing_shared_channel_blocked", {
        orgId: input.approval.orgId,
        channelId: defaultChannel.id,
        reason: sharedCheck.reason,
      });
      continue;
    }

    const recipient: DeliveryRecipient = {
      kind: "dm",
      provider: binding.provider,
      channelId: defaultChannel.id,
      externalUserId: binding.externalUserId,
    };

    const result = await adapter.sendDm(recipient, {
      text: buildApprovalSummaryText(input.approval, input.employee),
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

async function deliverToVotersDm(
  input: InboxRoutingInput,
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
    if (binding.provider !== "slack") {
      continue;
    }

    const sharedCheck = await adapter.isSharedChannel();
    if (sharedCheck.shared) {
      console.warn("inbox_routing_shared_channel_blocked", {
        orgId: input.approval.orgId,
        channelId: defaultChannel.id,
        reason: sharedCheck.reason,
      });
      continue;
    }

    const recipient: DeliveryRecipient = {
      kind: "dm",
      provider: binding.provider,
      channelId: defaultChannel.id,
      externalUserId: binding.externalUserId,
    };

    const result = await adapter.sendDm(recipient, {
      text: buildApprovalSummaryText(input.approval, input.employee),
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

function buildApprovalSummaryText(approval: ApprovalRequest, employee: Employee | null): string {
  const employeeName = employee?.displayName || "AI社員";
  const lines = [
    `承認依頼: ${approval.title}`,
    `AI社員: ${employeeName}`,
    `リスク: ${approval.risk}`,
    `目的: ${approval.purpose}`,
    "",
    approval.summary,
  ];
  return lines.join("\n");
}

export function getApprovalRouteClass(approval: ApprovalRequest): "business" | "admin" {
  return isAdminClassApproval(approval) ? "admin" : BUSINESS_AUDIT_CLASS;
}

export async function validateInboxRoutingDestination(
  orgId: string,
  channelId: string,
  provider: NotificationProvider
): Promise<{ valid: boolean; reason?: string }> {
  if (!hasDeliveryAdapter(provider)) {
    return { valid: false, reason: "no_adapter_for_provider" };
  }

  const adapter = await createDeliveryAdapter(provider, channelId, orgId);
  if (!adapter) {
    return { valid: false, reason: "adapter_creation_failed" };
  }

  const sharedCheck = await adapter.isSharedChannel();
  if (sharedCheck.shared) {
    return { valid: false, reason: sharedCheck.reason || "shared_channel_blocked" };
  }

  return { valid: true };
}

export type LineDmAdapterSeam = {
  deliverToLineDm: (
    orgId: string,
    lineUserId: string,
    text: string
  ) => Promise<DeliveryResult>;
};

let lineAdapterSeam: LineDmAdapterSeam | null = null;

export function registerLineAdapterSeam(seam: LineDmAdapterSeam): void {
  lineAdapterSeam = seam;
}

export function getLineAdapterSeam(): LineDmAdapterSeam | null {
  return lineAdapterSeam;
}
