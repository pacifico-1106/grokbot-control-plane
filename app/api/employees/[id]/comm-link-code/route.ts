/**
 * L-7 conversation link-code issue (Kimura 10/14).
 * Admin employee detail only. Owner or approve_actions (approvers). Not admin.
 * Same-org BOLA via getEmployee(id, actor.orgId). Issues for the actor, never
 * a memberId from the body. No admin MCP. Flags default OFF → 404.
 */
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { getEmployee } from "@/lib/data";
import { listCommAccounts } from "@/lib/comm/accounts";
import { isCommAccountsEnabled, isLineConversationEnabled } from "@/lib/comm/flags";
import { memberCanIssueConversationLinkCode } from "@/lib/employees/comm-link-code-permissions";
import { getPendingLineLinkCode, issueLineLinkCode } from "@/lib/line/link-code";
import { requireCapability } from "@/lib/team/demo-actor";
import { appendAuditEvent } from "@/lib/data/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) =>
  jsonUtf8(body, { status, headers: { "cache-control": "no-store" } });

async function gate(req: Request) {
  if (!isLineConversationEnabled() || !isCommAccountsEnabled()) {
    return { ok: false as const, response: json({ ok: false, error: "feature_disabled" }, 404) };
  }
  const cap = await requireCapability(req, "view_employees");
  if (!cap.ok) return cap;
  if (!memberCanIssueConversationLinkCode(cap.actor)) {
    return {
      ok: false as const,
      response: json({ ok: false, error: "approver_required", message: "オーナーまたは承認者だけが発行できます" }, 403),
    };
  }
  return { ok: true as const, actor: cap.actor };
}

async function employeeAccount(orgId: string, employeeId: string) {
  const employee = await getEmployee(employeeId, orgId);
  if (!employee || employee.orgId !== orgId) return { error: "employee_not_found" as const };
  const accounts = (await listCommAccounts(orgId)).filter(
    (a) => a.employeeId === employee.id && a.surface === "line"
  );
  if (accounts.length !== 1) return { error: "line_account_missing" as const, employee };
  return { employee, account: accounts[0] };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const found = await employeeAccount(g.actor.orgId, id);
  if ("error" in found && found.error === "employee_not_found") {
    return json({ ok: false, error: "employee_not_found" }, 404);
  }
  if ("error" in found) return json({ ok: false, error: found.error }, 409);
  const pending = await getPendingLineLinkCode({
    orgId: g.actor.orgId,
    channelId: found.account.id,
    memberId: g.actor.id,
  });
  return json({
    ok: true,
    employeeId: found.employee.id,
    accountId: found.account.id,
    pending: pending ? { expiresAt: pending.expiresAt } : null,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const found = await employeeAccount(g.actor.orgId, id);
  if ("error" in found && found.error === "employee_not_found") {
    return json({ ok: false, error: "employee_not_found" }, 404);
  }
  if ("error" in found) return json({ ok: false, error: found.error }, 409);
  const issued = await issueLineLinkCode({
    orgId: g.actor.orgId,
    channelId: found.account.id,
    memberId: g.actor.id,
    issuedByUserId: g.actor.id,
  });
  if (!issued.ok) {
    return json({ ok: false, error: issued.reason }, issued.reason === "secret_not_configured" ? 503 : 500);
  }
  await appendAuditEvent({
    orgId: g.actor.orgId,
    employeeId: found.employee.id,
    credentialId: null,
    action: "notification.channel_updated",
    purpose: null,
    summary: "LINE 会話の連携コードを発行した",
    metadata: {
      event: "line_conversation_link_issued",
      accountId: found.account.id,
      memberId: g.actor.id,
    },
  }).catch(() => undefined);
  return json({
    ok: true,
    display: issued.display,
    expiresAt: issued.expiresAt,
    memberId: g.actor.id,
    employeeId: found.employee.id,
    accountId: found.account.id,
  });
}
