/**
 * L-7: wake the AI employee from a per-employee LINE 1:1 (design §2-2 ②).
 * Flag LINE_CONVERSATION_ENABLED (default OFF). The conversation token is
 * already issued; this only delivers the wake. The message text is handed to
 * the employee and never stored or logged. Stop / leave is re-checked here
 * (G5, same as Slack postWake) so a hold placed after ingress still blocks.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getBinding, getWakeWebhookSecret } from "@/lib/data/bindings";
import { mcpHandoffWakeAuditMeta, withMcpHandoff } from "@/lib/mcp/endpoint-handoff";
import { checkOperable, takeWakeSuppressedAuditSlot, type OperableResult } from "@/lib/safety/hold";
import { withLinkLocalGuard } from "@/lib/webhooks/link-local-guard";

const WAKE_TIMEOUT_MS = 8_000;

export type LineWakeEvent = {
  orgId: string;
  employeeId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  text: string;
  eventKey: string;
  conversationToken: string;
  conversationTokenExpiresAt: string;
};

export type LineWakeAudit = Parameters<typeof appendAuditEvent>[0];

export type LineWakeDeps = {
  getBinding: typeof getBinding;
  getWakeWebhookSecret: typeof getWakeWebhookSecret;
  fetch: typeof fetch;
  checkOperable: (i: { orgId?: string | null; employeeId?: string | null; phase: "wake" }) => Promise<OperableResult>;
  appendAudit: (e: LineWakeAudit) => Promise<unknown>;
};

const defaultDeps: LineWakeDeps = {
  getBinding,
  getWakeWebhookSecret,
  fetch: (...args) => globalThis.fetch(...args),
  checkOperable: (i) => checkOperable(i),
  appendAudit: (e) => appendAuditEvent(e),
};

export async function dispatchLineConversationWake(
  event: LineWakeEvent,
  deps: Partial<LineWakeDeps> = {}
): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  let operable: OperableResult;
  try {
    operable = await d.checkOperable({ orgId: event.orgId, employeeId: event.employeeId, phase: "wake" });
  } catch {
    operable = { ok: false, code: "hold_state_unavailable", holdId: null, kind: null };
  }
  if (!operable.ok) {
    const slot = takeWakeSuppressedAuditSlot(`${event.orgId}:${event.employeeId}:${operable.code}`);
    if (!slot.write) return;
    await d.appendAudit({
      orgId: event.orgId,
      employeeId: event.employeeId,
      credentialId: null,
      action: "employee.hold.wake_suppressed",
      purpose: "comm.line",
      summary: "wake_suppressed_on_hold",
      metadata: {
        reason: operable.code,
        holdId: operable.holdId,
        trigger: "line_dm",
        accountId: event.accountId,
        eventKey: event.eventKey,
        suppressedSinceLastRow: slot.suppressed,
      },
    }).catch(() => undefined);
    return;
  }

  const binding = await d.getBinding(event.employeeId);
  const url = (binding?.wakeWebhookUrl || "").trim();
  if (!url) {
    await d.appendAudit({
      orgId: event.orgId,
      employeeId: event.employeeId,
      credentialId: null,
      action: "line.conversation_wake",
      purpose: "comm.line",
      summary: "wake_webhook_missing",
      metadata: { reason: "wake_webhook_missing", accountId: event.accountId, eventKey: event.eventKey },
    }).catch(() => undefined);
    return;
  }

  const payload = {
    surface: "line" as const,
    kind: "conversation" as const,
    trigger: "line_dm",
    orgId: event.orgId,
    employeeId: event.employeeId,
    accountId: event.accountId,
    conversationId: event.conversationId,
    senderId: event.senderId,
    text: event.text,
    eventKey: event.eventKey,
    conversationToken: event.conversationToken,
    conversationTokenExpiresAt: event.conversationTokenExpiresAt,
  };
  const wakeBody = await withMcpHandoff(payload, {
    orgId: event.orgId,
    employeeId: event.employeeId,
    surface: "line",
    kind: "conversation",
    trigger: "line_dm",
  });
  const secret = await d.getWakeWebhookSecret(event.employeeId);
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
      console.error("line_conversation_wake_http", { employeeId: event.employeeId, status: response.status });
      await d.appendAudit({
        orgId: event.orgId,
        employeeId: event.employeeId,
        credentialId: null,
        action: "line.conversation_wake",
        purpose: "comm.line",
        summary: "起こす webhook の送信に失敗",
        metadata: {
          reason: "wake_failed",
          accountId: event.accountId,
          eventKey: event.eventKey,
          ...mcpHandoffWakeAuditMeta(wakeBody, "line"),
        },
      }).catch(() => undefined);
      return;
    }
  } catch {
    console.error("line_conversation_wake_failed", { employeeId: event.employeeId });
    await d.appendAudit({
      orgId: event.orgId,
      employeeId: event.employeeId,
      credentialId: null,
      action: "line.conversation_wake",
      purpose: "comm.line",
      summary: "起こす webhook の送信に失敗",
      metadata: { reason: "wake_failed", accountId: event.accountId, eventKey: event.eventKey },
    }).catch(() => undefined);
    return;
  }

  await d.appendAudit({
    orgId: event.orgId,
    employeeId: event.employeeId,
    credentialId: null,
    action: "line.conversation_wake",
    purpose: "comm.line",
    summary: "LINE 1対1 から AI 社員を起こした",
    metadata: {
      reason: "woke",
      accountId: event.accountId,
      eventKey: event.eventKey,
      channel: event.conversationId,
      ts: event.eventKey,
      ...mcpHandoffWakeAuditMeta(wakeBody, "line"),
    },
  }).catch(() => undefined);
}
