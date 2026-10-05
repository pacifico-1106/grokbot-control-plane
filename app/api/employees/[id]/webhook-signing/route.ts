/**
 * D9: signing secret + payload mode for the employee's approval callback
 * (employee_webhook_settings). Behind WEBHOOK_HARDENING_ENABLED (404 when
 * OFF), except set_callback_payload: admins can mark receivers that need
 * legacy_full BEFORE the flag is turned on. With the flag OFF the mode is only
 * stored; delivery is unchanged (the OFF callback path never reads it).
 *
 * GET  → secret-free view: which key signs the callback (callback_secret |
 *        wake_secret | none), a 12-char fingerprint prefix, the payload mode.
 * POST { action: "mint_callback_secret" } → mints / rotates the callback
 *        secret; the plaintext whsec_… is returned ONCE (Cache-Control:
 *        no-store) and never again (stored encrypted, lib/notify/crypto.ts).
 * POST { action: "set_callback_payload", mode: "minimal" | "legacy_full" }
 *        → legacy_full is the opt-in compatibility body (title / summary /
 *        approver email / purpose / revision note).
 *
 * Authority = issuing / rotating a credential: owner/admin +
 * hire_issue_credentials (requireCredentialAdmin, fail-closed). The employee
 * must be in the caller's org. Audit rows carry no secret.
 * POST (every action, flag ON or OFF) is same-origin only (CSRF):
 * isSameOriginRequest, the same check as /api/auth/set-password → 403.
 */
import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/auth/auth-flow";
import { requireCredentialAdmin } from "@/lib/auth/require-credential-admin";
import { appendAuditEvent, getEmployee } from "@/lib/data";
import { isWebhookHardeningEnabled } from "@/lib/feature-flags";
import {
  CALLBACK_PAYLOAD_MODES,
  getWebhookSettingsView,
  mintCallbackSigningSecret,
  setCallbackPayloadMode,
  type CallbackPayloadMode,
} from "@/lib/webhooks/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const disabled = () => NextResponse.json({ ok: false, error: "feature_disabled" }, { status: 404 });

async function resolveTarget(req: Request, id: string, actorMemberId: string | null) {
  const gate = await requireCredentialAdmin(req, actorMemberId);
  if (!gate.ok) return { ok: false as const, response: gate.response };
  const orgId = await getCurrentOrgId();
  if (!orgId) return { ok: false as const, response: NextResponse.json({ ok: false, error: "auth_required" }, { status: 401 }) };
  const employee = await getEmployee(id, orgId);
  if (!employee) return { ok: false as const, response: NextResponse.json({ ok: false, error: "employee_not_found" }, { status: 404 }) };
  return { ok: true as const, actor: gate.actor, employee, orgId: employee.orgId || orgId };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isWebhookHardeningEnabled()) return disabled();
  const { id } = await ctx.params;
  const t = await resolveTarget(req, id, null);
  if (!t.ok) return t.response;
  const settings = await getWebhookSettingsView(t.employee.id, t.orgId);
  if (!settings) return NextResponse.json({ ok: false, error: "settings_unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, settings }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(req.headers, req.url)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const flagOn = isWebhookHardeningEnabled();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Flag OFF: only the payload-mode setting is available (stored, no delivery effect).
  if (!flagOn && body.action !== "set_callback_payload") return disabled();
  const { id } = await ctx.params;
  const t = await resolveTarget(req, id, typeof body.actorMemberId === "string" ? body.actorMemberId : null);
  if (!t.ok) return t.response;
  if (t.employee.status === "suspended") {
    return NextResponse.json({ ok: false, error: "employee_terminated" }, { status: 403 });
  }
  if (body.action === "mint_callback_secret") {
    let minted: { secret: string; fingerprint: string };
    try {
      minted = await mintCallbackSigningSecret(t.employee.id, t.orgId);
    } catch {
      return NextResponse.json({ ok: false, error: "settings_unavailable" }, { status: 503 });
    }
    const fingerprintPrefix = minted.fingerprint.slice(0, 12);
    await appendAuditEvent({
      orgId: t.orgId,
      employeeId: t.employee.id,
      credentialId: null,
      action: "employee.webhook_secret_minted",
      purpose: "webhook.signing",
      summary: "承認結果の callback の署名用の秘密を発行",
      metadata: { target: "approval_callback", fingerprintPrefix, actorId: t.actor.id },
    }).catch(() => undefined);
    return NextResponse.json(
      { ok: true, secret: minted.secret, fingerprintPrefix, note: "Shown once. Configure the receiver with this whsec_ secret (Standard Webhooks)." },
      { headers: { "cache-control": "no-store" } }
    );
  }
  if (body.action === "set_callback_payload") {
    const mode = body.mode;
    if (typeof mode !== "string" || !(CALLBACK_PAYLOAD_MODES as readonly string[]).includes(mode)) {
      return NextResponse.json({ ok: false, error: "invalid_callback_payload" }, { status: 400 });
    }
    try {
      await setCallbackPayloadMode(t.employee.id, t.orgId, mode as CallbackPayloadMode);
    } catch {
      return NextResponse.json({ ok: false, error: "settings_unavailable" }, { status: 503 });
    }
    await appendAuditEvent({
      orgId: t.orgId,
      employeeId: t.employee.id,
      credentialId: null,
      action: "employee.webhook_payload_mode_set",
      purpose: "webhook.payload",
      summary: mode === "legacy_full" ? "承認結果の callback を互換の本文（件名・要約・承認者を含む）に設定" : "承認結果の callback を最小の本文に設定",
      metadata: { target: "approval_callback", mode, actorId: t.actor.id, flagOn },
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, callbackPayload: mode });
  }
  return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
}
