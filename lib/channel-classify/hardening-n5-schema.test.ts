/** Follow-up to PR-B (N5): inputSchema enums match request-time validation. */
import { describe, expect, test } from "bun:test";
import { ADMIN_MCP_TOOLS } from "@/lib/mcp/admin-tools";
import { CHANNEL_CLASSIFICATIONS, CHANNEL_LEDGER_SURFACES, PARTY_AUDIENCES, PARTY_KINDS } from "@/lib/channel-classify/core";

function prop(tool: string, name: string): { type?: string; enum?: string[] } {
  const def = ADMIN_MCP_TOOLS.find((t) => t.name === tool);
  return ((def?.inputSchema as { properties: Record<string, { type?: string; enum?: string[] }> }).properties[name]) ?? {};
}

describe("N5 inputSchema enums", () => {
  test("channels.classify surface / classification", () => {
    expect(prop("channels.classify", "surface").enum).toEqual([...CHANNEL_LEDGER_SURFACES]);
    expect(prop("channels.classify", "classification").enum).toEqual([...CHANNEL_CLASSIFICATIONS]);
  });
  test("parties.upsert kind / audience", () => {
    expect(prop("parties.upsert", "kind").enum).toEqual([...PARTY_KINDS]);
    expect(prop("parties.upsert", "audience").enum).toEqual([...PARTY_AUDIENCES]);
  });
  test("types stay string", () => {
    for (const [tool, name] of [["channels.classify", "surface"], ["channels.classify", "classification"], ["parties.upsert", "kind"], ["parties.upsert", "audience"]]) {
      expect(prop(tool, name).type).toBe("string");
    }
  });
});
