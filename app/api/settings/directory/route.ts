import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  deleteOrgChannel,
  deleteOrgParty,
  listInformationAssets,
  listOrgChannels,
  listOrgParties,
  upsertOrgChannel,
  upsertOrgParty,
} from "@/lib/data";
import type {
  Audience,
  ChannelClassification,
  ConversationSurface,
  OrgPartyKind,
} from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const [parties, channels, assets] = await Promise.all([
    listOrgParties(gate.orgId),
    listOrgChannels(gate.orgId),
    listInformationAssets(gate.orgId),
  ]);
  return NextResponse.json({ ok: true, parties, channels, assets });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.record || body.type || "");
  try {
    if (kind === "party") {
      const partyKind = String(body.kind || "") as OrgPartyKind;
      const identifier = String(body.identifier || "").trim();
      const audience = body.audience === "internal" ? "internal" : "external";
      if (!identifier) return NextResponse.json({ error: "identifier_required" }, { status: 400 });
      const party = await upsertOrgParty({
        orgId: gate.orgId,
        kind: partyKind,
        identifier,
        audience: audience as Exclude<Audience, "unknown">,
      });
      return NextResponse.json({ ok: true, party });
    }
    if (kind === "channel") {
      const surface = String(body.surface || "slack") as ConversationSurface;
      const externalId = String(body.externalId || body.identifier || "").trim();
      const classification = String(body.classification || "unknown") as ChannelClassification;
      if (!externalId) return NextResponse.json({ error: "external_id_required" }, { status: 400 });
      const channel = await upsertOrgChannel({
        orgId: gate.orgId,
        surface,
        externalId,
        classification,
        mixed: body.mixed === true || classification === "shared_external",
      });
      return NextResponse.json({ ok: true, channel });
    }
    return NextResponse.json({ error: "invalid_record" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upsert_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const record = url.searchParams.get("record") || "";
  const id = url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  const ok =
    record === "channel"
      ? await deleteOrgChannel(gate.orgId, id)
      : await deleteOrgParty(gate.orgId, id);
  return NextResponse.json({ ok });
}
