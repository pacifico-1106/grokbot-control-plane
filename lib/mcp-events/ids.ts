/**
 * Deterministic identifiers for MCP Events.
 * - subscription id: f(principal, delivery.url, name, canonical arguments)
 *   (spec: deterministic over the key; a routing handle, not a capability)
 * - event id: f(org, approval, event name, status) — identical on every retry
 *   and every re-emit of the same occurrence, so receivers dedupe on
 *   webhook-id / eventId.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",")}}`;
}

function digest(parts: string[]): string {
  // JSON array encoding keeps component boundaries unambiguous.
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32);
}

export function subscriptionId(input: { principal: string; url: string; name: string; args: unknown }): string {
  return `sub_${digest(["mcp-events.subscription.v1", input.principal, input.url, input.name, canonicalJson(input.args)])}`;
}

export function approvalEventId(input: { orgId: string; approvalId: string; name: string; status: string }): string {
  return `evt_${digest(["mcp-events.event.v1", input.orgId, input.approvalId, input.name, input.status])}`;
}
