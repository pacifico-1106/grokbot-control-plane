import { NextResponse } from "next/server";
import { appendAuditEvent, listConversationAdapters, upsertConversationAdapter } from "@/lib/data";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { DASHBOARD_SLACK_ADAPTER_SAVE, recordSetupToolSucceeded } from "@/lib/approvals/attachment-retry-cap";
import type { ConversationSurface } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  return NextResponse.json({
    ok: true,
    adapters: await listConversationAdapters(gate.orgId),
  });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const surface = String(body.surface || "slack") as ConversationSurface;
  if (surface !== "slack") {
    return NextResponse.json({ error: "unsupported_surface" }, { status: 400 });
  }
  const enabled = body.enabled === true;
  const botToken = String(body.botToken || "").trim();
  try {
    const saved = await upsertConversationAdapter({
      orgId: gate.orgId,
      surface,
      label: String(body.label || "").trim(),
      enabled,
      config: {},
      secrets: { botToken },
    });
    await appendAuditEvent({
      orgId: gate.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: gate.email,
      action: "conversation.adapter_updated",
      purpose: null,
      summary: `Slack 会話投稿アダプタを${enabled ? "更新" : "無効化"}`,
      metadata: { adapterId: saved.id, surface, enabled },
    });
    // 木村 #255 third round d / fourth round 1: a dashboard save that enables
    // the Slack adapter or includes a bot token is a settings change →
    // retry-cap reset signal (reconcile flag ON only; best effort, never
    // changes this response). A save that only disables it is not.
    if (enabled || botToken !== "") {
      await recordSetupToolSucceeded({ orgId: gate.orgId, tool: DASHBOARD_SLACK_ADAPTER_SAVE, source: "dashboard_settings" })
        .catch(() => undefined);
    }
    return NextResponse.json({ ok: true, adapter: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save_failed" },
      { status: 400 }
    );
  }
}
