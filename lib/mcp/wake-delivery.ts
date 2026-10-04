/**
 * The ONE shared agent-wake sender (Slack mention / IM / user-token wakes,
 * approval.resolved callbacks, and any future LINE / Telegram / … wake).
 *
 * Enforcement of "every wake goes through withMcpHandoff()":
 *  - type:    `body` must be McpHandoffWakeBody<T>, a branded type only withMcpHandoff()
 *             produces → skipping the wrapper fails `tsc` / `next build`;
 *  - runtime: the exact object must come from withMcpHandoff() (module WeakSet), so a cast
 *             or a copy is refused before anything is sent;
 *  - static:  lib/mcp/wake-handoff-enforcement.test.ts fails on raw fetch() wakes elsewhere.
 * Flag MCP_ENDPOINT_HANDOFF_ENABLED OFF: withMcpHandoff() returns the same object, so the
 * request is byte-identical to before.
 */
import { isHandedOffWake, type McpHandoffWakeBody } from "@/lib/mcp/endpoint-handoff";

export type AgentWakeDelivery<T extends object> = {
  url: string;
  body: McpHandoffWakeBody<T>;
  headers: Record<string, string>;
  timeoutMs: number;
};

export async function deliverAgentWake<T extends object>(input: AgentWakeDelivery<T>): Promise<Response> {
  if (!isHandedOffWake(input.body)) {
    // Programming error: a wake that skipped withMcpHandoff(). Never send it.
    throw new Error("wake_without_mcp_handoff");
  }
  return fetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}
