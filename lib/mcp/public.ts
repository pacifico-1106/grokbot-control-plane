/**
 * Public MCP facts for dashboard + /docs/mcp (no secrets).
 * Keep in sync with public/.well-known/mcp/server-card.json.
 */

export const STAFFPASS_MCP_URL = "https://staffpass.sealith.com/api/mcp";
export const STAFFPASS_MCP_SERVER_CARD =
  "https://staffpass.sealith.com/.well-known/mcp/server-card.json";
export const STAFFPASS_MCP_DOCS_PATH = "/docs/mcp";
export const STAFFPASS_MCP_PATH = "/api/mcp";
export const STAFFPASS_MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

type Env = Record<string, string | undefined>;

/** STUB (TDD): absolute employee-badge MCP URL. */
export function staffpassMcpUrl(env: Env = process.env): string {
  void env;
  return STAFFPASS_MCP_URL;
}

/** STUB (TDD): absolute server card URL. */
export function staffpassMcpServerCardUrl(env: Env = process.env): string {
  void env;
  return STAFFPASS_MCP_SERVER_CARD;
}
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
