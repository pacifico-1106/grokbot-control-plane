/**
 * D9: hardened delivery of the approval.resolved callback
 * (WEBHOOK_HARDENING_ENABLED ON only; the OFF path stays inline in
 * lib/approvals/resolve-side-effects.ts, byte-for-byte as before).
 *
 * Body: minimal (ids + status) unless the employee's config opts into
 * legacy_full (employee_webhook_settings.callback_payload).
 * Headers: content-type + Standard Webhooks (webhook-id / -timestamp /
 * -signature). webhook-id = the MCP Events eventId when MCP Events produced
 * one for this decision (D7: the same id as the approval.decided delivery, so
 * a receiver that gets both dedupes on it); otherwise a stable hash of
 * (org, approval, status, resolvedAt) so repeats of one decision share it.
 * Transport: postHardenedWebhook (#267 postWebhook). No retries (as before).
 * Config / secret unreadable (incl. the wake-secret fallback) → not sent,
 * category config_unavailable, logged + audited with a fixed reason (never
 * silently unsigned, never the secret).
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getCallbackWebhookConfig } from "./settings";
import {
  postHardenedWebhook,
  signingKeyFromSecret,
  stableWebhookId,
  standardWebhookHeaders,
  type WebhookFailureCategory,
} from "./outbound";

export const CALLBACK_TIMEOUT_MS = 4000;
export const CALLBACK_USER_AGENT = "Staffpass-ApprovalHook/1.0";

/** Fields kept in the minimal body (always present, null when unknown). */
const MINIMAL_FIELDS = ["type", "status", "approvalId", "employeeId", "tool", "jobId", "risk", "resolvedAt", "revisionCount", "parentApprovalId"] as const;
/** Kept only when present (dedupe id / secret-free MCP handoff block). */
const OPTIONAL_FIELDS = ["eventId", "mcpHandoff"] as const;

export function minimalCallbackBody(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MINIMAL_FIELDS) out[k] = payload[k] ?? null;
  for (const k of OPTIONAL_FIELDS) if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  return out;
}

/** Returns null on success, else a failure category. Never throws. */
export async function deliverHardenedApprovalCallback(input: {
  url: string;
  orgId: string;
  employeeId: string;
  approvalId: string;
  status: string;
  resolvedAt: string | null | undefined;
  eventId: string | null;
  payload: Record<string, unknown>;
}): Promise<WebhookFailureCategory | null> {
  try {
    const cfg = await getCallbackWebhookConfig(input.employeeId, input.orgId);
    if (cfg.state === "error") {
      console.error("approval_callback_config_unavailable", input.employeeId, cfg.reason);
      await appendAuditEvent({
        orgId: input.orgId,
        employeeId: input.employeeId,
        credentialId: null,
        action: "approval.callback_config_unavailable",
        purpose: "approval.resolved",
        summary: "承認結果の callback を送らなかった（署名の設定を読めない）",
        metadata: { target: "approval_callback", category: "config_unavailable", reason: cfg.reason, approvalId: input.approvalId, hardened: true },
      }).catch(() => undefined);
      return "config_unavailable";
    }
    const body = JSON.stringify(cfg.payload === "legacy_full" ? input.payload : minimalCallbackBody(input.payload));
    const msgId = input.eventId || stableWebhookId("cb", [input.orgId, input.approvalId, input.status, input.resolvedAt ?? ""]);
    const headers = {
      "content-type": "application/json",
      ...standardWebhookHeaders(signingKeyFromSecret(cfg.signingSecret), msgId, Math.floor(Date.now() / 1000), body),
    };
    const r = await postHardenedWebhook(input.url, body, headers, { timeoutMs: CALLBACK_TIMEOUT_MS, userAgent: CALLBACK_USER_AGENT });
    return r.ok ? null : r.category;
  } catch {
    return "connection_failed";
  }
}
