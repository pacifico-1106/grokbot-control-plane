import { NextResponse } from "next/server";
import { appendAuditEvent, listNotificationChannels } from "@/lib/data";
import { getSessionContext } from "@/lib/auth/session";
import { DEMO_MEMBERS } from "@/lib/demo-data";
import { listVoterBindings } from "@/lib/approval-workflow/voter-binding";
import { isLineApproverLinkEnabled } from "@/lib/line/flags";
import { getPendingLineLinkCode, issueLineLinkCode } from "@/lib/line/link-code";
import type { OrgMember } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LINE approver self-link (G1/G4). The signed-in member issues a one-time code
 * for THEMSELVES and sends it to the LINE official account in a 1:1 chat. The
 * code is bound to (org, LINE channel, this member) — no member id is accepted
 * from the request body, so nobody can issue a code that links someone else.
 * Flag LINE_APPROVER_LINK_ENABLED (default OFF) → 404.
 */

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

type Gate = { ok: true; orgId: string; member: OrgMember; userId: string | null } | { ok: false; response: NextResponse };

async function requireApproverMember(): Promise<Gate> {
  const session = await getSessionContext();
  if (session.demo && session.orgId) {
    // Demo session has no member row; act as the demo owner.
    const member = DEMO_MEMBERS.find((item) => item.orgId === session.orgId && item.status === "active");
    if (member) return { ok: true, orgId: session.orgId, member, userId: session.userId };
  }
  const member = session.member;
  if (!session.userId || !session.orgId || !member || member.orgId !== session.orgId || member.status !== "active") {
    return { ok: false, response: json({ ok: false, error: "auth_required", message: "認証と組織が必要です" }, 401) };
  }
  const canApprove =
    member.role === "owner" || member.role === "admin" || (member.capabilities || []).includes("approve_actions");
  if (!canApprove) {
    return { ok: false, response: json({ ok: false, error: "approver_required", message: "承認権限のあるメンバーのみ連携できます" }, 403) };
  }
  return { ok: true, orgId: session.orgId, member, userId: session.userId };
}

async function findLineChannel(orgId: string, channelId: string) {
  if (!channelId || channelId.length > 200) return null;
  const channels = await listNotificationChannels(orgId);
  return channels.find((channel) => channel.id === channelId && channel.provider === "line") ?? null;
}

const notFound = () => json({ ok: false, error: "not_found" }, 404);

export async function GET(req: Request) {
  if (!isLineApproverLinkEnabled()) return notFound();
  const gate = await requireApproverMember();
  if (!gate.ok) return gate.response;
  const channelId = new URL(req.url).searchParams.get("channelId")?.trim() || "";
  const channel = await findLineChannel(gate.orgId, channelId);
  if (!channel) return notFound();
  const [pending, bindings] = await Promise.all([
    getPendingLineLinkCode({ orgId: gate.orgId, channelId: channel.id, memberId: gate.member.id }),
    listVoterBindings({ orgId: gate.orgId, provider: "line", channelKey: channel.id, memberId: gate.member.id }),
  ]);
  return json({
    ok: true,
    enabled: true,
    pending,
    linked: bindings.filter((binding) => binding.status === "active").map((binding) => binding.externalUserId),
  });
}

export async function POST(req: Request) {
  if (!isLineApproverLinkEnabled()) return notFound();
  const gate = await requireApproverMember();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const channel = await findLineChannel(gate.orgId, String(body.channelId || "").trim());
  if (!channel) return notFound();
  const issued = await issueLineLinkCode({
    orgId: gate.orgId,
    channelId: channel.id,
    memberId: gate.member.id,
    issuedByUserId: gate.userId,
  });
  if (!issued.ok) {
    const status = issued.reason === "secret_not_configured" || issued.reason === "storage_unavailable" ? 503 : 500;
    return json({ ok: false, error: issued.reason, message: "連携コードを発行できませんでした" }, status);
  }
  await appendAuditEvent({
    orgId: gate.orgId,
    employeeId: null,
    credentialId: null,
    action: "notification.channel_updated",
    purpose: null,
    summary: "LINE 承認者の連携コードを発行",
    metadata: {
      event: "line_approver_link_code_issued",
      provider: "line",
      channelId: channel.id,
      memberId: gate.member.id,
      expiresAt: issued.expiresAt,
    },
  }).catch(() => undefined);
  return json({ ok: true, code: issued.display, expiresAt: issued.expiresAt });
}
