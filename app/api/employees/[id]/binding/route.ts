import { NextResponse } from "next/server";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  appendAuditEvent,
  bindingPublicView,
  ensureBindingRow,
  getBinding,
  getEmployee,
  runtimeModeLabel,
  updateWakeWebhook,
} from "@/lib/data";
import { policyErrorPayload } from "@/lib/employees/policy-errors";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  const binding =
    (await getBinding(id)) ??
    (await ensureBindingRow(id, employee.orgId || orgId || ""));
  return NextResponse.json({
    ok: true,
    demo: runtimeModeLabel() === "demo",
    mode: runtimeModeLabel(),
    binding: bindingPublicView(binding),
  });
}

function parseWakeUrl(value: unknown): { ok: true; url: string | null } | { ok: false } {
  if (value == null) return { ok: true, url: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, url: null };
  if (trimmed.length > 2048) return { ok: false };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return { ok: false };
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false };
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireCapability(
    req,
    "hire_issue_credentials",
    typeof body.actorMemberId === "string" ? body.actorMemberId : null
  );
  if (!gate.ok) return gate.response;
  const orgId = await getCurrentOrgId();
  if (!orgId) return NextResponse.json(policyErrorPayload("auth_required"), { status: 401 });
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return NextResponse.json(policyErrorPayload("employee_not_found"), { status: 404 });
  if (employee.status === "suspended") {
    return NextResponse.json(policyErrorPayload("employee_terminated"), { status: 403 });
  }

  const patch: { orgId: string; url?: string | null; secret?: string | null } = {
    orgId: employee.orgId || orgId,
  };
  if ("wakeWebhookUrl" in body) {
    const parsedUrl = parseWakeUrl(body.wakeWebhookUrl);
    if (!parsedUrl.ok) {
      return NextResponse.json(policyErrorPayload("invalid_wake_webhook_url"), { status: 400 });
    }
    patch.url = parsedUrl.url;
  }
  if (typeof body.wakeWebhookSecret === "string") {
    patch.secret = body.wakeWebhookSecret;
  }
  if (patch.url === undefined && patch.secret === undefined) {
    return NextResponse.json(policyErrorPayload("wake_webhook_url_required"), { status: 400 });
  }

  try {
    const binding = await updateWakeWebhook(id, patch);
    await appendAuditEvent({
      orgId,
      employeeId: id,
      credentialId: employee.credentialId,
      actorEmail: gate.actor.email,
      action: "gateway.link_changed",
      purpose: null,
      summary: `${employee.displayName} の起こす webhook を更新`,
      metadata: {
        hasWakeWebhook: binding.hasWakeWebhook,
        wakeWebhookUrl: binding.wakeWebhookUrl,
      },
    });
    const view = bindingPublicView(binding) as Record<string, unknown>;
    delete view.credentialFingerprint;
    return NextResponse.json({
      ok: true,
      message: "起こす webhook を保存しました",
      binding: view,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "revoked") {
      return NextResponse.json(policyErrorPayload("employee_terminated"), { status: 403 });
    }
    return NextResponse.json(policyErrorPayload("invalid_wake_webhook_url"), { status: 400 });
  }
}
