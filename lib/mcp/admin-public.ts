/**
 * Public facts for Staffpass Admin MCP (separate mouth from employee badge MCP).
 * Auth is org-admin (gb_adm_…), NEVER the employee badge header (gb_emp_…).
 * Do not share Authorization: Bearer gb_emp_ with this endpoint.
 */
import { resolveAppOrigin } from "@/lib/app-url";

export const STAFFPASS_ADMIN_MCP_PATH = "/api/mcp/admin";
export const STAFFPASS_ADMIN_MCP_TRANSPORT = "Streamable HTTP";
export const STAFFPASS_ADMIN_MCP_SERVER_CARD_PATH = "/.well-known/mcp/admin-server-card.json";

type Env = Record<string, string | undefined>;

/** Absolute admin MCP URL (`<app origin>/api/mcp/admin`) from config (resolveAppOrigin). */
export function staffpassAdminMcpUrl(env: Env = process.env): string {
  return `${resolveAppOrigin(env)}${STAFFPASS_ADMIN_MCP_PATH}`;
}

/** Absolute admin MCP server card URL. */
export function staffpassAdminMcpServerCardUrl(env: Env = process.env): string {
  return `${resolveAppOrigin(env)}${STAFFPASS_ADMIN_MCP_SERVER_CARD_PATH}`;
}

export const ADMIN_MCP_SERVER_NAME = "staffpass-admin";
export const ADMIN_MCP_SERVER_TITLE = "Staffpass Admin";
export const ADMIN_MCP_SERVER_VERSION = "1.0.0";

/** Prefix is not an employee badge. Never accept gb_emp_ here. */
export const ADMIN_CREDENTIAL_PREFIX = "gb_adm_";

export const ADMIN_MCP_TOOL_NAMES = [
  "employees.issue",
  "link",
  "policy.patch",
  "employees.allowedAccounts.add",
  "employees.allowedAccounts.remove",
  "employees.allowedAccounts.list",
  "employees.postingIdentity.set",
  "parties.upsert",
  "channels.classify",
  "roles.propose",
  "setup.slackStatus",
  "setup.slackAdapter.setBotToken",
  "setup.connectInternalBase",
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
  "approvalWorkflow.get",
  "approvalWorkflow.patch",
  "approvalWorkflow.inspect",
  "approvalWorkflow.remind",
  "approvalWorkflow.bindVoter",
  "approvalWorkflow.unbindVoter",
  "approvalWorkflow.resendVoterVerification",
  "approvalWorkflow.listVoterBindings",
  "setup.approverBindingStatus",
  "approvalRoutes.get",
  "approvalRoutes.patch",
  "orgs.create",
  "orgs.status",
  "orgs.patch",
  "orgs.issueAdminCredential",
  "approvals.proxyResolve",
  "employeeIdentity.status",
  "employeeIdentity.upsert",
  "employeeIdentity.bindMailbox",
  "setup.slackDmApprovalStatus",
  "dmAutoroute.list",
  "dmAutoroute.run",
  "setup.approvalDelivery.autoResolve",
  "setup.slackApprover.set",
  "setup.slackAuthorizeLink.issue",
] as const;

export type AdminMcpToolName = (typeof ADMIN_MCP_TOOL_NAMES)[number];
