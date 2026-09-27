import { describe, expect, test } from "bun:test";
import {
  GATEWAY_TOOL_DEFS,
  isAlwaysHumanTool,
  isForceApprovalTool,
  resolveGatewayTool,
} from "@/lib/gateway/tools";

describe("calendar.allowlist.patch gateway tool", () => {
  test("tool definition exists", () => {
    expect(GATEWAY_TOOL_DEFS["calendar.allowlist.patch"]).toBeDefined();
  });

  test("tool is forceNeedsApproval", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.allowlist.patch"];
    expect(def.forceNeedsApproval).toBe(true);
  });

  test("tool mayAuto is false", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.allowlist.patch"];
    expect(def.mayAuto).toBe(false);
  });

  test("tool is always_human", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.allowlist.patch"];
    expect(isAlwaysHumanTool(def)).toBe(true);
  });

  test("tool requires force approval", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.allowlist.patch"];
    expect(isForceApprovalTool(def)).toBe(true);
  });

  test("tool requires calendar:read scope", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.allowlist.patch"];
    expect(def.requiredScopes).toContain("calendar:read");
  });

  test("resolves from normalized name", () => {
    const result = resolveGatewayTool("calendar.allowlist.patch");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.def.id).toBe("calendar.allowlist.patch");
    }
  });

  test("resolves from alias", () => {
    const result = resolveGatewayTool("calendar:allowlist.patch");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.def.id).toBe("calendar.allowlist.patch");
    }
  });

  test("resolves from alternate alias", () => {
    const result = resolveGatewayTool("calendar.allowlist:patch");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.def.id).toBe("calendar.allowlist.patch");
    }
  });
});

describe("calendar.read gateway tool", () => {
  test("tool definition exists", () => {
    expect(GATEWAY_TOOL_DEFS["calendar.read"]).toBeDefined();
  });

  test("tool is not forceNeedsApproval", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.read"];
    expect(def.forceNeedsApproval).toBe(false);
  });

  test("tool mayAuto is true", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.read"];
    expect(def.mayAuto).toBe(true);
  });

  test("tool has read kind", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.read"];
    expect(def.kind).toBe("read");
  });
});

describe("calendar.propose gateway tool", () => {
  test("tool definition exists", () => {
    expect(GATEWAY_TOOL_DEFS["calendar.propose"]).toBeDefined();
  });

  test("tool is not forceNeedsApproval", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.propose"];
    expect(def.forceNeedsApproval).toBe(false);
  });

  test("tool has propose kind", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.propose"];
    expect(def.kind).toBe("propose");
  });
});

describe("calendar.confirm gateway tool", () => {
  test("tool definition exists", () => {
    expect(GATEWAY_TOOL_DEFS["calendar.confirm"]).toBeDefined();
  });

  test("tool is forceNeedsApproval", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.confirm"];
    expect(def.forceNeedsApproval).toBe(true);
  });

  test("tool mayAuto is false", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.confirm"];
    expect(def.mayAuto).toBe(false);
  });

  test("tool has confirm kind", () => {
    const def = GATEWAY_TOOL_DEFS["calendar.confirm"];
    expect(def.kind).toBe("confirm");
  });
});
