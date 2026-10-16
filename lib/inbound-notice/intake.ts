/**
 * Shared inbound-notice intake. Vendor adapters parse; this module verifies
 * source, applies sales/emergency policy, and wakes through the existing
 * webhook + hold + audit path. Sends still go through the approval gateway
 * (this module never invokes it).
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getBinding, getWakeWebhookSecret } from "@/lib/data/bindings";
import { getOrgChannel } from "@/lib/data/directory";
import { getEmployee } from "@/lib/data/employees";
import { getEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { isInboundCallNoticeEnabled } from "@/lib/inbound-notice/flags";
import { readInboundNoticeConfig } from "@/lib/inbound-notice/config";
import { parseWithAdapters } from "@/lib/inbound-notice/adapters";
import { verifyInboundNoticeSource } from "@/lib/inbound-notice/accept";
import { isYes } from "@/lib/inbound-notice/parse";
import { maskPhoneForAudit } from "@/lib/inbound-notice/phone";
import { fenceUntrustedFields } from "@/lib/inbound-notice/untrusted";
import { INBOUND_NOTICE_SCHEMA } from "@/lib/inbound-notice/types";
import type { InboundNoticeRejectReason } from "@/lib/inbound-notice/types";
import { mcpHandoffWakeAuditMeta, withMcpHandoff } from "@/lib/mcp/endpoint-handoff";
import { checkOperable, takeWakeSuppressedAuditSlot, type OperableResult } from "@/lib/safety/hold";
import { recordThreadWake } from "@/lib/thread-guard/guard";
import { withLinkLocalGuard } from "@/lib/webhooks/link-local-guard";

const WAKE_TIMEOUT_MS = 8_000;
const PURPOSE = "inbound_notice";

export type InboundNoticeSlackEvent = {
  teamId: string;
  eventId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  text: string;
  botId: string;
  appId: string;
  subtype?: string;
};

export type InboundNoticeAudit = Parameters<typeof appendAuditEvent>[0];

export type InboundNoticeDeps = {
  now: () => Date;
  getOrgChannel: (orgId: string, surface: "slack", externalId: string) => Promise<{ orgId: string } | null>;
  getEmployee: (id: string, orgId: string) => Promise<{ id: string; orgId: string } | null>;
  getEmployeeSlackTeamId: (employeeId: string) => Promise<string>;
  getBinding: typeof getBinding;
  getWakeWebhookSecret: typeof getWakeWebhookSecret;
  fetch: typeof fetch;
  checkOperable: (i: { orgId?: string | null; employeeId?: string | null; phase: "wake" }) => Promise<OperableResult>;
  appendAudit: (e: InboundNoticeAudit) => Promise<unknown>;
  recordThreadWake: typeof recordThreadWake;
};

const defaultDeps: InboundNoticeDeps = {
  now: () => new Date(),
  getOrgChannel: async (orgId, surface, externalId) => getOrgChannel(orgId, surface, externalId),
  getEmployee: async (id, orgId) => getEmployee(id, orgId),
  getEmployeeSlackTeamId: async (employeeId) => {
    const ident = await getEmployeeSlackIdentity(employeeId);
    return ident?.slackTeamId ?? "";
  },
  getBinding,
  getWakeWebhookSecret,
  fetch: (...args) => globalThis.fetch(...args),
  checkOperable: (i) => checkOperable(i),
  appendAudit: (e) => appendAuditEvent(e),
  recordThreadWake,
};

export type InboundNoticeOutcome = {
  handled: boolean;
  woke: number;
  skipReason?: string;
};

function phoneMeta(phone: string | null): { phoneLast4: string | null; phoneHash: string | null } {
  return maskPhoneForAudit(phone);
}

export async function handleInboundNotice(
  event: InboundNoticeSlackEvent,
  deps: Partial<InboundNoticeDeps> = {}
): Promise<InboundNoticeOutcome> {
  if (!isInboundCallNoticeEnabled()) {
    return { handled: false, woke: 0, skipReason: "feature_flag_off" };
  }
  const d = { ...defaultDeps, ...deps };
  const config = readInboundNoticeConfig();
  if (!config) {
    return { handled: true, woke: 0, skipReason: "config_missing" };
  }

  const parsed = parseWithAdapters(event.text);
  if (!parsed) {
    return { handled: false, woke: 0, skipReason: "not_inbound_notice" };
  }

  const employee = await d.getEmployee(config.employeeId, config.orgId);
  const channel = await d.getOrgChannel(config.orgId, "slack", event.channelId);
  const employeeTeam = await d.getEmployeeSlackTeamId(config.employeeId);
  const source = verifyInboundNoticeSource({
    orgId: config.orgId,
    employeeId: employee?.id ?? "",
    employeeOrgId: employee?.orgId ?? "",
    employeeSlackTeamId: employeeTeam,
    teamId: event.teamId,
    channelId: event.channelId,
    channelRegistered: Boolean(channel),
    channelOrgId: channel?.orgId ?? "",
    botId: event.botId,
    appId: event.appId,
    allowedChannelIds: config.channelIds,
    allowedBotIds: config.botIds,
    allowedAppIds: config.appIds,
    expectedOrgId: config.orgId,
    expectedTeamId: config.slackTeamId,
    expectedEmployeeId: config.employeeId,
  });
  const phone = phoneMeta(parsed.fields.phone);
  if (!source.ok) {
    await d.appendAudit({
      orgId: config.orgId,
      employeeId: employee?.id ?? null,
      credentialId: null,
      action: "inbound_notice.rejected",
      purpose: PURPOSE,
      summary: "inbound_notice_rejected",
      metadata: {
        reason: source.reason,
        eventId: event.eventId,
        channel: event.channelId,
        ...phone,
      },
    }).catch(() => undefined);
    return { handled: true, woke: 0, skipReason: source.reason };
  }

  const isSalesCall = isYes(parsed.fields.salesCall);
  const isEmergency = isYes(parsed.fields.emergency);
  const priority = isEmergency ? "high" : "normal";
  const orgId = config.orgId;
  const employeeId = config.employeeId;

  if (isSalesCall) {
    await d.appendAudit({
      orgId,
      employeeId,
      credentialId: null,
      action: "inbound_notice.sales_skipped",
      purpose: PURPOSE,
      summary: "sales_call_notice_audit_only",
      metadata: {
        reason: "sales_skipped",
        eventId: event.eventId,
        channel: event.channelId,
        ts: event.ts,
        source: parsed.source,
        adapterId: parsed.adapterId,
        ...phone,
      },
    }).catch(() => undefined);
    return { handled: true, woke: 0, skipReason: "sales_call" };
  }

  let operable: OperableResult;
  try {
    operable = await d.checkOperable({ orgId, employeeId, phase: "wake" });
  } catch {
    operable = { ok: false, code: "hold_state_unavailable", holdId: null, kind: null };
  }
  if (!operable.ok) {
    const slot = takeWakeSuppressedAuditSlot(`${orgId}:${employeeId}:${operable.code}`);
    if (slot.write) {
      await d.appendAudit({
        orgId,
        employeeId,
        credentialId: null,
        action: "employee.hold.wake_suppressed",
        purpose: PURPOSE,
        summary: "wake_suppressed_on_hold",
        metadata: {
          reason: operable.code,
          holdId: operable.holdId,
          trigger: "inbound_notice",
          channel: event.channelId,
          ts: event.ts,
          eventId: event.eventId,
          suppressedSinceLastRow: slot.suppressed,
          ...phone,
        },
      }).catch(() => undefined);
    }
    return { handled: true, woke: 0, skipReason: "hold" };
  }

  const binding = await d.getBinding(employeeId);
  const url = (binding?.wakeWebhookUrl || "").trim();
  if (!url) {
    await d.appendAudit({
      orgId,
      employeeId,
      credentialId: null,
      action: "inbound_notice.wake",
      purpose: PURPOSE,
      summary: "wake_webhook_missing",
      metadata: {
        reason: "wake_webhook_missing",
        eventId: event.eventId,
        channel: event.channelId,
        ts: event.ts,
        ...phone,
      },
    }).catch(() => undefined);
    return { handled: true, woke: 0, skipReason: "wake_webhook_missing" };
  }

  const payload = {
    surface: "slack" as const,
    kind: "inbound_notice" as const,
    trigger: "ai_concier",
    priority,
    orgId,
    employeeId,
    eventId: event.eventId,
    channel: event.channelId,
    ts: event.ts,
    thread_ts: event.threadTs,
    acceptedAt: d.now().toISOString(),
    inboundNotice: {
      schema: INBOUND_NOTICE_SCHEMA,
      source: parsed.source,
      adapterId: parsed.adapterId,
      untrustedOutsideText: fenceUntrustedFields(parsed.fields),
    },
  };

  const wakeBody = await withMcpHandoff(payload, {
    orgId,
    employeeId,
    surface: "slack",
    kind: "conversation",
    trigger: "inbound_notice",
  });
  const secret = await d.getWakeWebhookSecret(employeeId);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;

  try {
    const response = await d.fetch(
      url,
      withLinkLocalGuard({
        method: "POST",
        headers,
        body: JSON.stringify(wakeBody),
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
      })
    );
    if (!response.ok) {
      console.error("inbound_notice_wake_http", { employeeId, status: response.status, eventId: event.eventId });
      await d.appendAudit({
        orgId,
        employeeId,
        credentialId: null,
        action: "inbound_notice.wake",
        purpose: PURPOSE,
        summary: "起こす webhook の送信に失敗",
        metadata: {
          reason: "wake_failed",
          eventId: event.eventId,
          channel: event.channelId,
          ts: event.ts,
          ...phone,
          ...mcpHandoffWakeAuditMeta(wakeBody, "slack"),
        },
      }).catch(() => undefined);
      return { handled: true, woke: 0, skipReason: "wake_failed" };
    }
  } catch {
    console.error("inbound_notice_wake_failed", { employeeId, eventId: event.eventId });
    await d.appendAudit({
      orgId,
      employeeId,
      credentialId: null,
      action: "inbound_notice.wake",
      purpose: PURPOSE,
      summary: "起こす webhook の送信に失敗",
      metadata: { reason: "wake_failed", eventId: event.eventId, channel: event.channelId, ...phone },
    }).catch(() => undefined);
    return { handled: true, woke: 0, skipReason: "wake_failed" };
  }

  if (event.ts) {
    await d.recordThreadWake({
      orgId,
      employeeId,
      keyInput: {
        orgId,
        surface: "slack",
        slackChannelId: event.channelId,
        threadId: event.threadTs || event.ts,
      },
      ts: event.ts,
    }).catch(() => false);
  }

  await d.appendAudit({
    orgId,
    employeeId,
    credentialId: null,
    action: "inbound_notice.wake",
    purpose: PURPOSE,
    summary: "受電通知で AI 社員を起こした",
    metadata: {
      reason: "woke",
      eventId: event.eventId,
      channel: event.channelId,
      ts: event.ts,
      source: parsed.source,
      adapterId: parsed.adapterId,
      priority,
      isEmergency,
      ...phone,
      ...mcpHandoffWakeAuditMeta(wakeBody, "slack"),
    },
  }).catch(() => undefined);

  return { handled: true, woke: 1 };
}

export type { InboundNoticeRejectReason };
