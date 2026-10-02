/**
 * After a consent is granted, tell the org's owners/admins (design §6.8).
 * Best-effort email via the existing Resend path; contains no secrets.
 */
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
