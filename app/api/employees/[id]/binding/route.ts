import { assertWebActorApproverAuthority, webDirectDeniedBody } from "@/lib/approver-authority/web-direct";
import { getCurrentOrgId } from "@/lib/auth/session";
import {
  appendAuditEvent,
  bindingPublicView,
  getBindingForDisplay,
  getEmployee,
  runtimeModeLabel,
  updateWakeWebhook,
} from "@/lib/data";
import { policyErrorPayload } from "@/lib/employees/policy-errors";
import { requireCapability } from "@/lib/team/demo-actor";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const orgId = await getCurrentOrgId();
  const employee = await getEmployee(id, orgId);
  if (!employee) {
    return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  }
  // Read-only: a missing row is reported as unlinked, not created.
  const binding = await getBindingForDisplay(id, employee.orgId || orgId || "");
  return jsonUtf8({
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
  if (!orgId) return jsonUtf8(policyErrorPayload("auth_required"), { status: 401 });
  const { id } = await ctx.params;
  const employee = await getEmployee(id, orgId);
  if (!employee) return jsonUtf8(policyErrorPayload("employee_not_found"), { status: 404 });
  if (employee.status === "suspended") {
    return jsonUtf8(policyErrorPayload("employee_terminated"), { status: 403 });
  }

  const patch: { orgId: string; url?: string | null; secret?: string | null } = {
    orgId: employee.orgId || orgId,
  };
  if ("wakeWebhookUrl" in body) {
    const parsedUrl = parseWakeUrl(body.wakeWebhookUrl);
    if (!parsedUrl.ok) {
      return jsonUtf8(policyErrorPayload("invalid_wake_webhook_url"), { status: 400 });
    }
    patch.url = parsedUrl.url;
  }
  if (typeof body.wakeWebhookSecret === "string") {
    patch.secret = body.wakeWebhookSecret;
  }
  if (patch.url === undefined && patch.secret === undefined) {
    return jsonUtf8(policyErrorPayload("wake_webhook_url_required"), { status: 400 });
  }
  // Review 2026-10-09 item 2: the wake destination decides where the employee is woken / notified.
  const authority = await assertWebActorApproverAuthority({
    orgId,
    memberId: gate.actor.id,
    actorEmail: gate.actor.email,
    changes: [{ tool: "web.employeeBinding", adminMutation: {}, kind: "owner_or_designated_admin" }],
    surface: "employees.binding",
  });
  if (!authority.ok) return jsonUtf8(webDirectDeniedBody(authority), { status: 403 });

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
    return jsonUtf8({
      ok: true,
      message: "起こす webhook を保存しました",
      binding: view,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "revoked") {
      return jsonUtf8(policyErrorPayload("employee_terminated"), { status: 403 });
    }
    return jsonUtf8(policyErrorPayload("invalid_wake_webhook_url"), { status: 400 });
  }
}
