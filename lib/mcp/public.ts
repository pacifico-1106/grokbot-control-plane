/**
 * Public MCP facts for dashboard + /docs/mcp (no secrets).
 * Keep in sync with public/.well-known/mcp/server-card.json.
 */

export const STAFFPASS_MCP_URL = "https://staffpass.sealith.com/api/mcp";
/** Badge-only mouth (flag MCP_EMPLOYEE_BADGE_MCP_ENABLED). Never advertises OAuth. */
export const STAFFPASS_MCP_EMPLOYEE_URL = "https://staffpass.sealith.com/api/mcp/employee";
export const STAFFPASS_MCP_SERVER_CARD =
  "https://staffpass.sealith.com/.well-known/mcp/server-card.json";
export const STAFFPASS_MCP_DOCS_PATH = "/docs/mcp";
export const STAFFPASS_MCP_TRANSPORT = "Streamable HTTP";

export const STAFFPASS_MCP_TOOL_NAMES = [
  "staffpass_whoami",
  "staffpass_invoke",
  "staffpass_get_approval_status",
  "staffpass_health",
  "staffpass_stuck_list",
  "staffpass_stuck_retry",
  "staffpass_decision_request",
] as const;

export type StaffpassMcpToolName = (typeof STAFFPASS_MCP_TOOL_NAMES)[number];
