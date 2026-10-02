/**
 * Web API for P1 Channel Scope (CS2)
 *
 * GET   /api/channel-scope[?employeeId=…]  — read effective scope (owner/admin)
 * PATCH /api/channel-scope                 — file an always_human channelScope.patch ticket
 *                                            (owner/admin). NEVER writes the policy directly;
 *                                            it is applied only after a different human approves.
 * POST is accepted as an alias of PATCH (same shape as /api/approval-routes).
 *
 * Body (PATCH): { employeeId?, clearOverride?, mode, includeSlackConnect?, connect?, beforeStateHash? }
 * Flags: P1_CHANNEL_SCOPE_ENABLED (default OFF), P1_CHANNEL_SCOPE_CONNECT_ENABLED (default OFF).
 */
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { assertApiPlanAllows } from "@/lib/billing/plan-api-gate";
import { appendAuditEvent } from "@/lib/data";
import { queueAdminToolForRequester } from "@/lib/admin-mcp/queue";
import {
  buildChannelScopeQueuedArgs,
  CHANNEL_SCOPE_PATCH_TOOL,
  CHANNEL_SCOPE_TITLE_JA,
  handleChannelScopeGet,
  prepareChannelScopePatch,
} from "@/lib/channel-scope/admin";

export const runtime = "nodejs";

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

async function requireOwnerOrAdmin() {
  const session = await getSessionContext();
  const orgId = session.orgId;
  if (!orgId) return { ok: false as const, response: jsonError("auth_required", 401) };
  const member = session.member;
  if (!member || member.orgId !== orgId || !["owner", "admin"].includes(member.role) || member.status !== "active") {
    return { ok: false as const, response: jsonError("owner_or_admin_required", 403) };
  }
  return { ok: true as const, orgId, member };
}

export async function GET(req: Request) {
  const gate = await requireOwnerOrAdmin();
  if (!gate.ok) return gate.response;
  const employeeId = new URL(req.url).searchParams.get("employeeId") || undefined;
  const result = await handleChannelScopeGet(gate.orgId, { employeeId });
  if (!result.ok) {
    return jsonError(result.code, result.code === "employee_not_found" ? 404 : 400, { message: result.message });
  }
  return NextResponse.json(result);
}

export async function PATCH(req: Request) {
  const gate = await requireOwnerOrAdmin();
  if (!gate.ok) return gate.response;
  const { orgId, member } = gate;

  const planGate = await assertApiPlanAllows(orgId, "channel_scope", "チャンネル範囲設定の変更");
  if (!planGate.ok) return planGate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("invalid_body", 400);
  const args = body as Record<string, unknown>;
  if (args.approvalId !== undefined || args.jobId !== undefined) {
    return jsonError("validation_failed", 400, { message: "approvalId / jobId は Web API では指定できません" });
  }

  const prepared = await prepareChannelScopePatch(orgId, args, "web_api");
  if (!prepared.ok) {
    if (prepared.code === "before_state_mismatch") {
      await appendAuditEvent({
        orgId,
        employeeId: null,
        credentialId: null,
        actorEmail: member.email,
        action: "channel_scope.patch_conflict",
        purpose: "admin.policy",
        summary: "チャンネル範囲変更: before-state mismatch (Web API)",
        metadata: { expectedHash: args.beforeStateHash ?? null, source: "web_api", actorMemberId: member.id },
      });
    }
    return jsonError(prepared.code, prepared.status, {
      message: prepared.message,
      ...(prepared.validationErrors ? { errors: prepared.validationErrors } : {}),
    });
  }

  const queued = await queueAdminToolForRequester({
    orgId,
    // Self-approval guard compares this actorId with the resolver's org_members.id.
    requester: { kind: "admin_agent", grokBotAgentId: null, actorId: member.id },
    tool: CHANNEL_SCOPE_PATCH_TOOL,
    args: buildChannelScopeQueuedArgs({}, prepared.snapshot),
    title: CHANNEL_SCOPE_TITLE_JA,
    summary: prepared.summary,
    jobId: `channel-scope-${Date.now().toString(36)}`,
    extraMetadata: { source: "web_api", actorEmail: member.email, actorMemberId: member.id },
  });
  if (queued.code !== "needs_approval") {
    return jsonError(queued.code, 403, { message: "messageJa" in queued ? queued.messageJa : undefined });
  }
  return NextResponse.json({
    ok: true,
    code: "needs_approval",
    always_human: true,
    approvalClass: "admin",
    approvalId: queued.approvalId,
    pollPath: queued.pollPath,
    diffSummary: prepared.snapshot.diffSummary,
    message: "承認リクエストを作成しました。別の承認者（owner）が承認した後に設定が適用されます。",
  });
}

export const POST = PATCH;
