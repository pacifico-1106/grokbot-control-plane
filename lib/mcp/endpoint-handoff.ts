/**
 * MCP endpoint handoff — interface stub (TDD step 1; implementation follows).
 */
import type { AuditEvent } from "@/lib/types";

export const MCP_HANDOFF_SCHEMA = "staffpass.mcp_handoff.v1" as const;
export const MCP_ACTIVITY_LOOKBEHIND_MS = 15 * 60_000;
export type McpHandoffSurface = "slack" | "line" | "telegram" | "web" | "admin_proxy";
export type McpHandoffKind = "conversation" | "approval_resolved";
export type McpConnectionStatus = "seen" | "not_seen" | "not_connected_suspected" | "unknown";
export type McpHandoff = {
  schema: typeof MCP_HANDOFF_SCHEMA;
  employeeId: string;
  mcp: {
    url: string;
    transport: "streamable_http";
    serverCardUrl: string;
    docsUrl: string;
    auth: {
      type: "bearer";
      header: "Authorization";
      format: string;
      alternateHeader: "x-staffpass-credential";
      credential: "employee_badge";
      included: false;
    };
  };
  connectivityCheck: {
    tool: "staffpass_whoami";
    fallbackTool: "staffpass_health";
    arguments: Record<string, never>;
    jsonRpc: { method: "tools/call"; params: { name: "staffpass_whoami"; arguments: Record<string, never> } };
    expect: { employeeId: string };
  };
  reply: { mcpTool: "staffpass_invoke"; gatewayTool: "comm.reply" };
  setupSteps: Array<{ id: "register_mcp_server" | "attach_badge" | "verify"; ja: string }>;
  ifNotConnectedJa: string;
  wake?: { surface: McpHandoffSurface; kind: McpHandoffKind; trigger: string };
  connection?: { status: McpConnectionStatus; lastSeenAt: string | null };
};
export type McpWakeContext = {
  orgId: string;
  employeeId: string;
  surface: McpHandoffSurface;
  kind: McpHandoffKind;
  trigger: string;
};
export type McpSeenCredential = {
  employeeId: string;
  orgId: string;
  credentialId: string | null;
  generation: number;
};

export function resolveMcpEndpointUrl(_env?: Record<string, string | undefined>): string {
  throw new Error("not_implemented");
}
export function buildMcpHandoff(_input: {
  employeeId: string;
  wake?: McpHandoff["wake"];
  connection?: McpHandoff["connection"];
}): McpHandoff {
  throw new Error("not_implemented");
}
export async function withMcpHandoff<T extends object>(
  payload: T,
  _ctx: McpWakeContext
): Promise<T & { mcpHandoff?: McpHandoff }> {
  return payload;
}
export function resetMcpClientSeenThrottleForTests(): void {}
export async function recordMcpClientSeen(
  _cred: McpSeenCredential,
  _method: string,
  _tool?: string
): Promise<void> {}
export async function getMcpConnectionState(
  _orgId: string,
  _employeeId: string
): Promise<{ status: McpConnectionStatus; lastSeenAt: string | null }> {
  return { status: "unknown", lastSeenAt: null };
}
export function isMcpHandoffWakeAudit(_event: AuditEvent): boolean {
  return false;
}
export function evaluateMcpNotConnected(_input: {
  wake: AuditEvent;
  audits: AuditEvent[];
  now: Date;
  complete: boolean;
}): { eligible: boolean; reason?: string; itemId: string } {
  return { eligible: false, reason: "not_implemented", itemId: "" };
}
export type McpNotConnectedResult = {
  ok: boolean;
  employeeId: string;
  itemId: string;
  surface: McpHandoffSurface;
  notified: boolean;
};
export async function processMcpNotConnectedWatchForOrg(
  _orgId: string,
  _opts?: { now?: Date }
): Promise<McpNotConnectedResult[]> {
  return [];
}
export async function processMcpNotConnectedWatchAllOrgs(): Promise<McpNotConnectedResult[]> {
  return [];
}
