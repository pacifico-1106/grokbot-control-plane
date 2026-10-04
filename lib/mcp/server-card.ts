/**
 * MCP server cards (`/.well-known/mcp/server-card.json`, `/.well-known/mcp/admin-server-card.json`).
 * Was static JSON in public/ with a hardcoded host; now every URL comes from the app
 * origin config (resolveAppOrigin) — never request headers. Production with the env
 * unset yields exactly the previous static cards (see lib/mcp/__fixtures__ + test).
 * No secrets.
 */
import { resolveAppOrigin } from "@/lib/app-url";
import { STAFFPASS_ADMIN_MCP_PATH } from "@/lib/mcp/admin-public";
import { STAFFPASS_MCP_DOCS_PATH, STAFFPASS_MCP_PATH } from "@/lib/mcp/public";

type Env = Record<string, string | undefined>;

export function buildServerCard(env: Env = process.env): Record<string, unknown> {
  const origin = resolveAppOrigin(env);
  return {
    name: "staffpass",
    title: "Staffpass",
    description: "Staffpass remote MCP — ID badges for AI agents. Fail-closed Gateway: whoami, invoke (purpose+jobId), approval status poll, health, stuck watch list/retry (badge-scoped). Confirm/send/order require human approval with explicit approvalId/statusToken/pollUrl return pipe.",
    version: "1.0.0",
    websiteUrl: origin,
    documentationUrl: `${origin}${STAFFPASS_MCP_DOCS_PATH}`,
    transport: {
      type: "streamable-http",
      url: `${origin}${STAFFPASS_MCP_PATH}`,
    },
    authentication: {
      type: "http",
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer gb_emp_<…>",
      alternateHeaders: [
        "x-staffpass-credential"
      ]
    },
    tools: [
      "staffpass_whoami",
      "staffpass_invoke",
      "staffpass_get_approval_status",
      "staffpass_health",
      "staffpass_stuck_list",
      "staffpass_stuck_retry"
    ],
    capabilities: {
      tools: true
    },
    notes: [
      "Public HTTPS only — no local stdio for Grok Bot Plugins / grok.com connectors.",
      "clients should set allowed_tools to staffpass_* tools (whoami, invoke, get_approval_status, health, stuck_list, stuck_retry).",
      "On needs_approval, poll pollUrl / staffpass_get_approval_status; do not complete confirm/send/order while pending."
    ],
  };
}

export function buildAdminServerCard(env: Env = process.env): Record<string, unknown> {
  const origin = resolveAppOrigin(env);
  return {
    name: "staffpass-admin",
    title: "Staffpass Admin",
    description: "Staffpass Admin remote MCP — tenant admin mouth (hire / link / policy / parties / channels / roles.propose / setup diagnostics). Most tools are always_human. Separate from the employee badge MCP at /api/mcp.",
    version: "1.0.0",
    websiteUrl: origin,
    documentationUrl: `${origin}${STAFFPASS_MCP_DOCS_PATH}`,
    transport: {
      type: "streamable-http",
      url: `${origin}${STAFFPASS_ADMIN_MCP_PATH}`,
    },
    authentication: {
      type: "http",
      scheme: "bearer",
      header: "Authorization",
      format: "Bearer gb_adm_<…>",
      alternateHeaders: [
        "x-staffpass-admin-credential"
      ],
      notEmployeeBadge: true
    },
    tools: [
      "employees.issue",
      "link",
      "policy.patch",
      "parties.upsert",
      "channels.classify",
      "roles.propose",
      "setup.slackStatus",
      "setup.slackAdapter.setBotToken",
      "setup.lineApprovalStatus",
      "setup.lineApproval.upsert",
      "setup.lineApproval.setEmployeeInbox",
      "setup.lineApproval.demoteTelegram",
      "ingressHandoff.get",
      "ingressHandoff.patch",
      "schedulingPolicy.get",
      "schedulingPolicy.patch",
      "replyPolicy.get",
      "replyPolicy.patch",
      "mailPolicy.get",
      "mailPolicy.patch",
      "internalAudienceRule.get",
      "internalAudienceRule.patch",
      "stuckWatch.get",
      "stuckWatch.patch",
      "stuckWatch.list",
      "stuckWatch.inspect",
      "stuckWatch.retry",
      "stuckWatch.resolve",
      "stuckWatch.classify",
      "orgs.create",
      "orgs.status",
      "orgs.patch",
      "orgs.issueAdminCredential",
      "approvals.proxyResolve"
    ],
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    notes: [
      "Separate mouth from employee badge MCP (/api/mcp, gb_emp_). Never share that header here.",
      "Most tools are always_human: create an approval ticket; do not mutate until a different human approves.",
      "setup.slackStatus is read-only and does not require approval. Use it to diagnose Slack integration before guiding human setup.",
      "setup.slackAdapter.setBotToken registers the conversation posting adapter Bot token (つながり → チャンネルに書き込む（会社のBot）). always_human. NOT the approval-inbox Slack under 承認を受け取る.",
      "setup.lineApprovalStatus is read-only and does not require approval. Diagnose LINE approval-inbox channels (承認を受け取る → 承認用LINE) before Space Tree kickoff.",
      "setup.lineApproval.upsert / setEmployeeInbox / demoteTelegram configure the LINE approval inbox (always_human). NOT conversation LINE (P1) or Slack posting adapter.",
      "Admin cannot grant itself extra scopes or approve its own request.",
      "channels.classify with employeeId installs Slack IM ingress for that employee. Omitting employeeId removes the ingress (fail-closed).",
      "ingressHandoff supports per-employee overrides: include employeeId in get/patch to manage AI社員ごとの設定. Fallback order: employee override → org policy → default. Use clearOverride=true to clear employee override and inherit org policy.",
      "orgs.create / orgs.status / orgs.patch / orgs.issueAdminCredential are platform super-admin tools (SUPER_ADMIN allowlist + optional PLATFORM_OPS_ORG_ID). Normal tenant gb_adm_ receives platform_ops_forbidden. orgs.create and orgs.issueAdminCredential are always_human. orgs.patch is NOT always_human (platform-ops actor is the human deciding; same rationale as trial-extension via UI). orgs.issueAdminCredential mints gb_adm_ for a target orgId (not the caller ops org); oneTimeSecret is returned once after approval.",
      "approvals.proxyResolve is a platform super-admin tool for resolving a tenant's pending approval on their behalf during setup/support. Requires mandate (setup | support) and optional note for audit. Audit records: targetOrgId, approvalId, mandate, note, actorEmail, actorUserId, decision, timestamp. NOT wrapped in another always_human ticket — this tool IS the human decision for platform ops. Use when tenant's LINE/Telegram approval inbox is empty during setup代行."
    ],
  };
}
