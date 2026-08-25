/**
 * Public MCP facts for dashboard + /docs/mcp (no secrets).
 * Keep in sync with public/.well-known/mcp/server-card.json.
 */

export const STAFFPASS_MCP_URL = "https://staffpass.sealith.com/api/mcp";
export const STAFFPASS_MCP_SERVER_CARD =
  "https://staffpass.sealith.com/.well-known/mcp/server-card.json";
export const STAFFPASS_MCP_DOCS_PATH = "/docs/mcp";
export const STAFFPASS_MCP_TRANSPORT = "Streamable HTTP";

export const STAFFPASS_MCP_TOOL_NAMES = [
  "staffpass_whoami",
  "staffpass_invoke",
  "staffpass_get_approval_status",
  "staffpass_health",
] as const;

export type StaffpassMcpToolName = (typeof STAFFPASS_MCP_TOOL_NAMES)[number];
