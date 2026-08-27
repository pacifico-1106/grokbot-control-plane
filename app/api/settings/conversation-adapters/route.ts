import { NextResponse } from "next/server";
import { appendAuditEvent, listConversationAdapters, upsertConversationAdapter } from "@/lib/data";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
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
  try {
    const saved = await upsertConversationAdapter({
      orgId: gate.orgId,
      surface,
      label: String(body.label || "").trim(),
      enabled,
      config: {},
      secrets: { botToken: String(body.botToken || "").trim() },
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
    return NextResponse.json({ ok: true, adapter: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save_failed" },
      { status: 400 }
    );
  }
}
