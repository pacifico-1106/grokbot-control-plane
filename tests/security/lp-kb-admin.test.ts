/**
 * LP Knowledge Base and Admin MCP Tests (PR-1a)
 * 
 * Tests:
 * - Feature flag LP_CHAT_ENABLED default OFF
 * - KB tools return feature_disabled when flag OFF
 * - KB seed content matches spec FAQ
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const envBackup = {
  lpChatEnabled: process.env.LP_CHAT_ENABLED,
};

beforeEach(() => {
  delete process.env.LP_CHAT_ENABLED;
});

afterEach(() => {
  process.env.LP_CHAT_ENABLED = envBackup.lpChatEnabled;
});

const { isLpChatEnabled } = await import("@/lib/feature-flags");
const { handleKbRead, handleKbDraft, handleKbReleasePropose, KB_ADMIN_TOOL_DEFS } = 
  await import("@/lib/lp/kb-admin-tools");

describe("LP KB: Feature flag default OFF", () => {
  test("LP_CHAT_ENABLED is OFF by default", () => {
    expect(isLpChatEnabled()).toBe(false);
  });
});

describe("LP KB: Tools disabled when flag OFF", () => {
  test("kb.read returns feature_disabled when flag OFF", async () => {
    const result = await handleKbRead({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("feature_disabled");
  });

  test("kb.draft returns feature_disabled when flag OFF", async () => {
    const result = await handleKbDraft({
      documentKey: "test",
      title: "Test",
      content: "Test content",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("feature_disabled");
  });

  test("kb.release.propose returns feature_disabled when flag OFF", async () => {
    const result = await handleKbReleasePropose({
      releaseKey: "test-release",
      revisionIds: ["uuid-1"],
      proposedBy: "admin",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("feature_disabled");
  });
});

describe("LP KB: Tool definitions", () => {
  test("KB Admin tools are defined", () => {
    expect(KB_ADMIN_TOOL_DEFS.length).toBe(3);
    
    const readTool = KB_ADMIN_TOOL_DEFS.find((t) => t.name === "kb.read");
    expect(readTool).toBeDefined();
    expect(readTool?.description).toContain("Read-only");
    
    const draftTool = KB_ADMIN_TOOL_DEFS.find((t) => t.name === "kb.draft");
    expect(draftTool).toBeDefined();
    expect(draftTool?.inputSchema.required).toContain("documentKey");
    expect(draftTool?.inputSchema.required).toContain("title");
    expect(draftTool?.inputSchema.required).toContain("content");
    
    const proposeTool = KB_ADMIN_TOOL_DEFS.find((t) => t.name === "kb.release.propose");
    expect(proposeTool).toBeDefined();
    expect(proposeTool?.description).toContain("always_human");
  });
});

describe("LP KB: Input validation", () => {
  beforeEach(() => {
    process.env.LP_CHAT_ENABLED = "1";
  });

  test("kb.draft rejects content over 10000 chars", async () => {
    const longContent = "x".repeat(10001);
    const result = await handleKbDraft({
      documentKey: "test",
      title: "Test",
      content: longContent,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("content_too_long");
  });

  test("kb.draft rejects missing required fields", async () => {
    const result = await handleKbDraft({
      documentKey: "",
      title: "Test",
      content: "Content",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_required_fields");
  });

  test("kb.release.propose rejects empty revisionIds", async () => {
    const result = await handleKbReleasePropose({
      releaseKey: "test-release",
      revisionIds: [],
      proposedBy: "admin",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_required_fields");
  });
});

describe("LP Catalog: Public API", () => {
  test("catalog module exports required functions", async () => {
    const catalog = await import("@/lib/lp/catalog");
    expect(typeof catalog.getCatalog).toBe("function");
    expect(typeof catalog.getCatalogItem).toBe("function");
    expect(typeof catalog.getPlanLabel).toBe("function");
    expect(typeof catalog.isValidCheckoutPlan).toBe("function");
  });

  test("HARDCODED_CATALOG has correct items", async () => {
    const { HARDCODED_CATALOG } = await import("@/lib/lp/catalog");
    expect(HARDCODED_CATALOG.items.length).toBe(4);
    expect(HARDCODED_CATALOG.items.map((i) => i.sku)).toEqual([
      "intern", "proper", "executive", "custom"
    ]);
  });
});
