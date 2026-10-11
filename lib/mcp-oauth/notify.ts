/**
 * After a consent is granted, tell the org's owners/admins (design §6.8).
 * Best-effort email via the existing Resend path; contains no secrets.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { listMembers } from "@/lib/data/members";
import { oauthIssuer } from "@/lib/mcp-oauth/config";
import { sendTransactionalEmail } from "@/lib/resend";
import type { ConsentNotifyInput } from "@/lib/mcp-oauth/consent";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function oauthConnectedEmail(input: ConsentNotifyInput): { subject: string; html: string; text: string } {
  const url = `${oauthIssuer()}/app/employees/${encodeURIComponent(input.employeeId)}`;
  const line = `${input.actorEmail} さんが AI 社員「${input.employeeName}」を ${input.clientHost || input.clientName} に接続しました。`;
  return {
    subject: `[Staffpass] AI 社員「${input.employeeName}」が ${input.clientHost || "AI クライアント"} に接続されました`,
    html: `<p>${esc(line)}</p><p>心当たりがない場合は、社員詳細画面からすぐに取り消してください。</p><p><a href="${esc(url)}">${esc(url)}</a></p>`,
    text: `${line}\n心当たりがない場合は、社員詳細画面からすぐに取り消してください。\n${url}`,
  };
}

export async function notifyOAuthConnected(input: ConsentNotifyInput): Promise<void> {
  const members = await listMembers(input.orgId);
  const to = Array.from(
    new Set(
      members
        .filter((m) => m.orgId === input.orgId && m.status === "active" && (m.role === "owner" || m.role === "admin"))
        .map((m) => (m.email || "").trim())
        .filter((e) => e.includes("@"))
    )
  );
  if (to.length === 0) return;
  const t = oauthConnectedEmail(input);
  await sendTransactionalEmail({
    to,
    template: "oauth_connected",
    subject: t.subject,
    html: t.html,
    text: t.text,
    tags: [{ name: "template", value: "oauth_connected" }],
  });
}

/** Refresh / code reuse → grant already revoked; tell owners/admins (best-effort, no secrets). */
export async function notifyOAuthSecurityEvent(n: { orgId: string; employeeId: string; clientHost: string; kind: "refresh_reuse" | "code_reuse" }): Promise<void> {
  const members = await listMembers(n.orgId);
  const to = Array.from(
    new Set(
      members
        .filter((m) => m.orgId === n.orgId && m.status === "active" && (m.role === "owner" || m.role === "admin"))
        .map((m) => (m.email || "").trim())
        .filter((e) => e.includes("@"))
    )
  );
  if (to.length === 0) return;
  const url = `${oauthIssuer()}/app/employees/${encodeURIComponent(n.employeeId)}`;
  const what = n.kind === "refresh_reuse" ? "リフレッシュトークン" : "認可コード";
  const line = `${n.clientHost} との OAuth 接続で${what}の再利用を検知したため、接続を自動で取り消しました。トークン漏えいの可能性があります。`;
  await sendTransactionalEmail({
    to,
    template: "oauth_security",
    subject: `[Staffpass] セキュリティ通知: ${n.clientHost} との接続を自動で取り消しました`,
    html: `<p>${esc(line)}</p><p>必要なら AI クライアントから再接続してください。</p><p><a href="${esc(url)}">${esc(url)}</a></p>`,
    text: `${line}\n必要なら AI クライアントから再接続してください。\n${url}`,
    tags: [{ name: "template", value: "oauth_security" }],
  });
}

const OPS_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * #318 follow-up: the DCR global daily cap was hit (registration is refused
 * for everyone until the window moves). Ops only, via the existing channels:
 * PLATFORM_OPS_ORG_ID audit mirror + APPROVAL_ALERT_OPS_EMAILS. Counts only
 * (no IPs, hashes or client names). The caller dedupes (once per day).
 * Never throws.
 */
export async function notifyOpsDcrGlobalCapReached(n: { count: number; cap: number }): Promise<"sent_ops" | "undelivered"> {
  let reached = false;
  const count = Math.max(0, Math.floor(Number(n.count) || 0));
  const cap = Math.max(0, Math.floor(Number(n.cap) || 0));
  const line = `MCP OAuth の動的クライアント登録（DCR）が 24 時間の全体上限（${cap} 件）に達しました（直近 24 時間: ${count} 件）。上限が下がるまで新しい登録はすべて 429 になります。`;
  const todo = "対処: 登録元の急増（悪用）か正規の利用増かを確認し、必要なら MCP_OAUTH_DCR_ENABLED を OFF にしてください。";
  const opsOrgId = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
  if (opsOrgId) {
    reached = await appendAuditEvent({
      orgId: opsOrgId,
      employeeId: null,
      credentialId: null,
      action: "oauth.dcr_global_cap_reached",
      purpose: null,
      summary: line,
      metadata: { auditClass: "admin", event: "oauth.dcr_global_cap_reached", count, cap },
    })
      .then(() => true)
      .catch(() => false);
  }
  const opsEmails = (process.env.APPROVAL_ALERT_OPS_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => OPS_EMAIL_RE.test(s))
    .slice(0, 10);
  if (opsEmails.length) {
    const mailed = await sendTransactionalEmail({
      to: opsEmails,
      template: "oauth_security",
      subject: "【運営】MCP OAuth: DCR の全体上限に達しました",
      html: `<p>${esc(line)}</p><p>${esc(todo)}</p>`,
      text: `${line}\n${todo}`,
      tags: [{ name: "template", value: "oauth_security" }],
    })
      .then((r) => Boolean((r as { ok?: boolean })?.ok))
      .catch(() => false);
    reached = reached || mailed;
  }
  if (!reached) console.warn("oauth_dcr_global_cap_reached", { count, cap });
  return reached ? "sent_ops" : "undelivered";
}
