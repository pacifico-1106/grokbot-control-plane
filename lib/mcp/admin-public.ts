/**
 * Public facts for Staffpass Admin MCP (separate mouth from employee badge MCP).
 * Auth is org-admin (gb_adm_…), NEVER the employee badge header (gb_emp_…).
 * Do not share Authorization: Bearer gb_emp_ with this endpoint.
 */
export const STAFFPASS_ADMIN_MCP_URL = "https://staffpass.sealith.com/api/mcp/admin";
export const STAFFPASS_ADMIN_MCP_SERVER_CARD =
  "https://staffpass.sealith.com/.well-known/mcp/admin-server-card.json";
export const STAFFPASS_ADMIN_MCP_PATH = "/api/mcp/admin";
export const STAFFPASS_ADMIN_MCP_TRANSPORT = "Streamable HTTP";

export const ADMIN_MCP_SERVER_NAME = "staffpass-admin";
export const ADMIN_MCP_SERVER_TITLE = "Staffpass Admin";
export const ADMIN_MCP_SERVER_VERSION = "1.0.0";

/** Prefix is not an employee badge. Never accept gb_emp_ here. */
export const ADMIN_CREDENTIAL_PREFIX = "gb_adm_";

export const ADMIN_MCP_TOOL_NAMES = [
  "employees.issue",
  "link",
  "policy.patch",
  "parties.upsert",
  "channels.classify",
  "roles.propose",
  "setup.slackStatus",
] as const;

export type AdminMcpToolName = (typeof ADMIN_MCP_TOOL_NAMES)[number];
