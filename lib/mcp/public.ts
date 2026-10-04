/**
 * Public MCP facts for dashboard + /docs/mcp (no secrets).
 * Absolute URLs are built from the app origin config (resolveAppOrigin) — never a
 * hardcoded host and never request headers. Production with the env unset resolves
 * to the canonical host (same values as before). Server card: lib/mcp/server-card.ts.
 */
import { resolveAppOrigin } from "@/lib/app-url";
export const STAFFPASS_MCP_DOCS_PATH = "/docs/mcp";
export const STAFFPASS_MCP_PATH = "/api/mcp";
export const STAFFPASS_MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";

type Env = Record<string, string | undefined>;

/** Absolute employee-badge MCP URL (`<app origin>/api/mcp`). */
export function staffpassMcpUrl(env: Env = process.env): string {
  return `${resolveAppOrigin(env)}${STAFFPASS_MCP_PATH}`;
}

/** Absolute employee MCP server card URL. */
export function staffpassMcpServerCardUrl(env: Env = process.env): string {
  return `${resolveAppOrigin(env)}${STAFFPASS_MCP_SERVER_CARD_PATH}`;
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
