/** STUB (TDD): the one shared agent-wake sender. */
import type { McpHandoffWakeBody } from "@/lib/mcp/endpoint-handoff";

export type AgentWakeDelivery<T extends object> = {
  url: string;
  body: McpHandoffWakeBody<T>;
  headers: Record<string, string>;
  timeoutMs: number;
};

export async function deliverAgentWake<T extends object>(input: AgentWakeDelivery<T>): Promise<Response> {
  return fetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}
