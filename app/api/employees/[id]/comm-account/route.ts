/**
 * L-8: owner/admin LINE conversation connect. Fetches the bot userId, stores
 * it on the comm account, PUTs the conversation webhook URL, and tests it.
 * Secrets are accepted from this browser form only — never from AI / Admin MCP.
 * Flags default OFF → 404. Same-org BOLA via getEmployee(id, actor.orgId).
 */
import { resolveAppOrigin } from "@/lib/app-url";
import { isLineWebhookAutoSetupEnabled } from "@/lib/comm/flags";
import { conversationWebhookUrl, findEmployeeLineAccount, setupLineConversationWebhook } from "@/lib/comm/line-webhook-setup";
import { appendAuditEvent, getEmployee } from "@/lib/data";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { requireCapability } from "@/lib/team/demo-actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) =>
  jsonUtf8(body, { status, headers: { "cache-control": "no-store" } });

function isOwnerOrAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function gate(req: Request) {
  if (!isLineWebhookAutoSetupEnabled()) {
    return { ok: false as const, response: json({ ok: false, error: "feature_disabled", message: "この機能は現在オフです" }, 404) };
  }
  const cap = await requireCapability(req, "view_employees");
  if (!cap.ok) return cap;
  if (!isOwnerOrAdmin(cap.actor.role)) {
    return {
      ok: false as const,
      response: json({ ok: false, error: "admin_required", message: "組織のオーナーまたは管理者だけが接続できます" }, 403),
    };
  }
  return { ok: true as const, actor: cap.actor };
}

function publicAccount(account: { id: string; status: string; externalAccountId: string; displayName: string | null; webhookPath: string; secretNames: string[]; secretsVerifiedAt: string | null }) {
  const ref = account.webhookPath.split("/").pop() || "";
  return {
    id: account.id,
    status: account.status,
    botUserId: account.externalAccountId,
    displayName: account.displayName,
    webhookPath: account.webhookPath,
    webhookUrl: conversationWebhookUrl(ref, resolveAppOrigin()),
    secretNames: account.secretNames,
    secretsVerifiedAt: account.secretsVerifiedAt,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const employee = await getEmployee(id, g.actor.orgId);
  if (!employee || employee.orgId !== g.actor.orgId) {
    return json({ ok: false, error: "employee_not_found", message: "対象の社員が見つかりません" }, 404);
  }
  const account = await findEmployeeLineAccount(g.actor.orgId, employee.id);
  return json({
    ok: true,
    employeeId: employee.id,
    account: account ? publicAccount(account) : null,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const employee = await getEmployee(id, g.actor.orgId);
  if (!employee || employee.orgId !== g.actor.orgId) {
    return json({ ok: false, error: "employee_not_found", message: "対象の社員が見つかりません" }, 404);
  }
  const existed = await findEmployeeLineAccount(g.actor.orgId, employee.id);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const hasSecrets = "channelAccessToken" in body || "channelSecret" in body;
  const secrets = hasSecrets
    ? { channelAccessToken: String(body.channelAccessToken || ""), channelSecret: String(body.channelSecret || "") }
    : undefined;
  const result = await setupLineConversationWebhook({
    orgId: g.actor.orgId,
    employeeId: employee.id,
    secrets,
    createdByMemberId: g.actor.id,
  });
  if (!result.ok) {
    const status =
      result.reason === "not_found" || result.reason === "employee_not_found"
        ? 404
        : result.reason === "employee_has_account" || result.reason === "external_account_taken" || result.reason === "bot_user_mismatch"
          ? 409
          : result.reason === "line_network" || result.reason === "webhook_set_failed" || result.reason === "webhook_test_failed" || result.reason === "webhook_test_rejected" || result.reason === "bot_info_http"
            ? 502
            : 400;
    return json({
      ok: false,
      error: result.reason,
      message: result.messageJa,
      ...(result.account ? { account: publicAccount(result.account) } : {}),
      ...(result.botUserId ? { botUserId: result.botUserId } : {}),
      ...(result.webhookUrl ? { webhookUrl: result.webhookUrl } : {}),
    }, status);
  }
  await appendAuditEvent({
    orgId: g.actor.orgId,
    employeeId: employee.id,
    credentialId: null,
    actorEmail: g.actor.email,
    action: existed ? "comm.account.secrets_set" : "comm.account.created",
    purpose: null,
    summary: existed ? "LINE 会話 Webhook を再登録した" : "LINE 会話公式アカウントを接続した",
    metadata: {
      event: "line_conversation_webhook_setup",
      accountId: result.account.id,
      botUserId: result.botUserId,
      webhookPath: result.account.webhookPath,
    },
  }).catch(() => undefined);
  return json({
    ok: true,
    employeeId: employee.id,
    botUserId: result.botUserId,
    webhookUrl: result.webhookUrl,
    account: publicAccount(result.account),
  });
}
