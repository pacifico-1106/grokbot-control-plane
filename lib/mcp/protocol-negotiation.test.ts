/**
 * D1 (2026-10-05): MCP protocol 2026-07-28 support — unit tests for the shared
 * negotiation / validation helpers used by /api/mcp and /api/mcp/admin.
 *
 * Spec (2026-07-28): basic/versioning, basic/transports/streamable-http
 * (Protocol Version Header, Standard Request Headers, Value Encoding, Server
 * Validation), server/discover, basic/index (per-request _meta fields).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  MCP_ERR_HEADER_MISMATCH,
  MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_LATEST_LEGACY_PROTOCOL_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_META_MAX_BYTES,
  MCP_META_MAX_KEYS,
  MCP_MODERN_PROTOCOL_VERSIONS,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  buildDiscoverResult,
  checkMcpProtocolRequest,
  decodeMcpHeaderValue,
  mcpCorsAllowHeaders,
  negotiateInitializeVersion,
  shapeModernResult,
} from "@/lib/mcp/protocol-negotiation";
import { isMcpStrictRequestHeadersEnabled } from "@/lib/feature-flags";

const ORIGINAL_STRICT = process.env.MCP_STRICT_REQUEST_HEADERS;
afterEach(() => {
  if (ORIGINAL_STRICT === undefined) delete process.env.MCP_STRICT_REQUEST_HEADERS;
  else process.env.MCP_STRICT_REQUEST_HEADERS = ORIGINAL_STRICT;
});

function req(headers: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

const MODERN_META = {
  [META_PROTOCOL_VERSION]: "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "ExampleClient", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernHeaders(method: string, extra: Record<string, string> = {}) {
  return { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...extra };
}

describe("supported versions (spec revisions)", () => {
  test("exact list, newest first: 2026-07-28 modern + four initialize-era revisions", () => {
    expect([...MCP_MODERN_PROTOCOL_VERSIONS]).toEqual(["2026-07-28"]);
    expect([...MCP_LEGACY_PROTOCOL_VERSIONS]).toEqual(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
    expect([...MCP_SUPPORTED_PROTOCOL_VERSIONS]).toEqual([
      "2026-07-28",
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);
    expect(MCP_LATEST_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(MCP_LATEST_LEGACY_PROTOCOL_VERSION).toBe("2025-11-25");
  });
});

describe("initialize negotiation (legacy lifecycle rule)", () => {
  for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    test(`supported ${v} is echoed`, () => {
      expect(negotiateInitializeVersion(v)).toBe(v);
    });
  }
  test("unsupported versions → latest initialize-era version 2025-11-25", () => {
    for (const requested of ["2026-07-28", "2099-01-01", "1900-01-01", "2024-10-07", "latest", "", "x".repeat(5000)]) {
      expect(negotiateInitializeVersion(requested)).toBe("2025-11-25");
    }
  });
  test("missing / non-string protocolVersion → 2024-11-05 (unchanged from before D1)", () => {
    expect(negotiateInitializeVersion(undefined)).toBe("2024-11-05");
    expect(negotiateInitializeVersion(null)).toBe("2024-11-05");
    expect(negotiateInitializeVersion(42)).toBe("2024-11-05");
  });
});

describe("Mcp-Name value decoding (Value Encoding)", () => {
  test("plain ASCII passes through", () => {
    expect(decodeMcpHeaderValue("staffpass_whoami")).toBe("staffpass_whoami");
    expect(decodeMcpHeaderValue("employees.issue")).toBe("employees.issue");
  });
  test("base64 sentinel is decoded (UTF-8)", () => {
    expect(decodeMcpHeaderValue(`=?base64?${Buffer.from("Hello, 世界").toString("base64")}?=`)).toBe("Hello, 世界");
  });
  test("malformed values are rejected", () => {
    expect(decodeMcpHeaderValue("=?base64?***?=")).toBeNull();
    expect(decodeMcpHeaderValue("=?base64?abc")).toBeNull();
    expect(decodeMcpHeaderValue(" padded ")).toBeNull();
    expect(decodeMcpHeaderValue("")).toBeNull();
    expect(decodeMcpHeaderValue(`=?base64?${Buffer.from([0xff, 0xfe]).toString("base64")}?=`)).toBeNull();
  });
});

describe("checkMcpProtocolRequest — legacy requests (no _meta protocolVersion)", () => {
  test("no headers at all → legacy, ok", () => {
    const r = checkMcpProtocolRequest(req(), "tools/list", {});
    expect(r).toEqual({ ok: true, era: "legacy", version: null });
  });
  test("supported legacy header → legacy, ok", () => {
    const r = checkMcpProtocolRequest(req({ "mcp-protocol-version": "2025-06-18" }), "tools/list", {});
    expect(r).toEqual({ ok: true, era: "legacy", version: "2025-06-18" });
  });
  test("unknown header version is ignored by default (as before D1)", () => {
    const r = checkMcpProtocolRequest(req({ "mcp-protocol-version": "2099-01-01" }), "tools/list", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.era).toBe("legacy");
  });
  test("unknown header version with strict flag → 400 UnsupportedProtocolVersion", () => {
    process.env.MCP_STRICT_REQUEST_HEADERS = "true";
    expect(isMcpStrictRequestHeadersEnabled()).toBe(true);
    const r = checkMcpProtocolRequest(req({ "mcp-protocol-version": "2099-01-01" }), "tools/list", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.code).toBe(MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION);
      expect(r.data).toEqual({ supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], requested: "2099-01-01" });
    }
  });
  test("initialize is always legacy, whatever the version header says", () => {
    for (const v of ["2026-07-28", "2099-01-01", "garbage"]) {
      const r = checkMcpProtocolRequest(req({ "mcp-protocol-version": v }), "initialize", { protocolVersion: "2025-06-18" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.era).toBe("legacy");
    }
  });
  test("legacy client sending _meta.progressToken only stays legacy", () => {
    const r = checkMcpProtocolRequest(req(), "tools/call", { name: "staffpass_whoami", _meta: { progressToken: 1 } });
    expect(r).toEqual({ ok: true, era: "legacy", version: null });
  });
  test("non-object _meta is ignored, not rejected (backward compatible)", () => {
    const r = checkMcpProtocolRequest(req(), "tools/list", { _meta: "x" } as Record<string, unknown>);
    expect(r.ok).toBe(true);
  });
});

describe("checkMcpProtocolRequest — modern requests (2026-07-28)", () => {
  test("complete modern request → modern, ok", () => {
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", { _meta: MODERN_META });
    expect(r).toEqual({ ok: true, era: "modern", version: "2026-07-28" });
  });
  test("tools/call with matching Mcp-Name (plain and base64)", () => {
    const params = { name: "staffpass_whoami", arguments: {}, _meta: MODERN_META };
    expect(checkMcpProtocolRequest(req(modernHeaders("tools/call", { "mcp-name": "staffpass_whoami" })), "tools/call", params).ok).toBe(true);
    const b64 = `=?base64?${Buffer.from("staffpass_whoami").toString("base64")}?=`;
    expect(checkMcpProtocolRequest(req(modernHeaders("tools/call", { "mcp-name": b64 })), "tools/call", params).ok).toBe(true);
  });
  test("MCP-Protocol-Version header ≠ body _meta → 400 HeaderMismatch (-32020)", () => {
    const r = checkMcpProtocolRequest(
      req({ "mcp-protocol-version": "2025-06-18", "mcp-method": "tools/list" }),
      "tools/list",
      { _meta: MODERN_META }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.code).toBe(MCP_ERR_HEADER_MISMATCH);
    }
  });
  test("Mcp-Method header ≠ body method → 400 HeaderMismatch (any era)", () => {
    const modern = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/call", { name: "staffpass_whoami", _meta: MODERN_META });
    expect(modern.ok).toBe(false);
    if (!modern.ok) expect([modern.httpStatus, modern.code]).toEqual([400, MCP_ERR_HEADER_MISMATCH]);
    const legacy = checkMcpProtocolRequest(req({ "mcp-method": "tools/list" }), "tools/call", { name: "staffpass_whoami" });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect([legacy.httpStatus, legacy.code]).toEqual([400, MCP_ERR_HEADER_MISMATCH]);
    const init = checkMcpProtocolRequest(req({ "mcp-method": "tools/list" }), "initialize", {});
    expect(init.ok).toBe(false);
  });
  test("Mcp-Name header ≠ params.name → 400 HeaderMismatch; malformed → 400", () => {
    const params = { name: "staffpass_invoke", arguments: {}, _meta: MODERN_META };
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/call", { "mcp-name": "staffpass_whoami" })), "tools/call", params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.httpStatus, r.code]).toEqual([400, MCP_ERR_HEADER_MISMATCH]);
    const bad = checkMcpProtocolRequest(req(modernHeaders("tools/call", { "mcp-name": "=?base64?%%?=" })), "tools/call", params);
    expect(bad.ok).toBe(false);
  });
  test("unsupported body version → 400 UnsupportedProtocolVersion (-32022) with supported list", () => {
    const meta = { ...MODERN_META, [META_PROTOCOL_VERSION]: "2027-01-01" };
    const r = checkMcpProtocolRequest(
      req({ "mcp-protocol-version": "2027-01-01", "mcp-method": "tools/list" }),
      "tools/list",
      { _meta: meta }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.code).toBe(MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION);
      expect(r.message).toBe("Unsupported protocol version");
      expect(r.data).toEqual({ supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], requested: "2027-01-01" });
    }
  });
  test("non-date requested version is never reflected", () => {
    const evil = "<script>alert(1)</script>";
    const r = checkMcpProtocolRequest(req({ "mcp-method": "tools/list" }), "tools/list", {
      _meta: { ...MODERN_META, [META_PROTOCOL_VERSION]: evil },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r)).not.toContain("script");
      expect(r.data).toEqual({ supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS] });
    }
  });
  test("non-string body version → 400 Invalid params (-32602)", () => {
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", {
      _meta: { ...MODERN_META, [META_PROTOCOL_VERSION]: 20260728 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.httpStatus, r.code]).toEqual([400, -32602]);
  });
  test("mismatch messages never echo header values", () => {
    const r = checkMcpProtocolRequest(
      req(modernHeaders("tools/call", { "mcp-name": "attacker-controlled-value" })),
      "tools/call",
      { name: "staffpass_whoami", _meta: MODERN_META }
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("attacker-controlled-value");
  });
  test("missing headers on a modern request: accepted by default, rejected with strict flag", () => {
    const params = { name: "staffpass_whoami", _meta: MODERN_META };
    expect(checkMcpProtocolRequest(req(), "tools/call", params)).toEqual({ ok: true, era: "modern", version: "2026-07-28" });
    process.env.MCP_STRICT_REQUEST_HEADERS = "true";
    const partialHeaders: Array<Record<string, string>> = [
      {},
      { "mcp-protocol-version": "2026-07-28" },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" },
    ];
    for (const headers of partialHeaders) {
      const r = checkMcpProtocolRequest(req(headers), "tools/call", params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect([r.httpStatus, r.code]).toEqual([400, MCP_ERR_HEADER_MISMATCH]);
    }
    expect(
      checkMcpProtocolRequest(req(modernHeaders("tools/call", { "mcp-name": "staffpass_whoami" })), "tools/call", params).ok
    ).toBe(true);
  });
  test("strict flag: modern request without clientCapabilities → 400 -32602", () => {
    process.env.MCP_STRICT_REQUEST_HEADERS = "true";
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", {
      _meta: { [META_PROTOCOL_VERSION]: "2026-07-28" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.httpStatus, r.code]).toEqual([400, -32602]);
  });
  test("modern header without body _meta: served as modern by default, 400 -32602 with strict flag", () => {
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", {});
    expect(r).toEqual({ ok: true, era: "modern", version: "2026-07-28" });
    process.env.MCP_STRICT_REQUEST_HEADERS = "true";
    const s = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", {});
    expect(s.ok).toBe(false);
    if (!s.ok) expect([s.httpStatus, s.code]).toEqual([400, -32602]);
  });
});

describe("_meta is size-bounded and never reflected", () => {
  test("unknown _meta keys are accepted and ignored", () => {
    const r = checkMcpProtocolRequest(req(modernHeaders("tools/list")), "tools/list", {
      _meta: { ...MODERN_META, "openai/locale": "ja-JP", "com.example/trace": { a: 1 } },
    });
    expect(r).toEqual({ ok: true, era: "modern", version: "2026-07-28" });
  });
  test(`_meta larger than ${MCP_META_MAX_BYTES} bytes → 400 -32602 (any era)`, () => {
    const big = { blob: "x".repeat(MCP_META_MAX_BYTES + 1) };
    for (const meta of [big, { ...MODERN_META, ...big }]) {
      const r = checkMcpProtocolRequest(req(), "tools/list", { _meta: meta });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect([r.httpStatus, r.code]).toEqual([400, -32602]);
        expect(JSON.stringify(r)).not.toContain("xxxx");
      }
    }
  });
  test(`_meta with more than ${MCP_META_MAX_KEYS} keys → 400 -32602`, () => {
    const many = Object.fromEntries(Array.from({ length: MCP_META_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]));
    const r = checkMcpProtocolRequest(req(), "tools/list", { _meta: many });
    expect(r.ok).toBe(false);
  });
});

describe("result shaping", () => {
  const info = { name: "staffpass", version: "1.0.0" };
  test("modern results carry resultType complete + serverInfo, keep existing fields", () => {
    expect(shapeModernResult({ tools: [] }, info)).toEqual({
      resultType: "complete",
      tools: [],
      _meta: { [META_SERVER_INFO]: info },
    });
    expect(shapeModernResult({ content: [], _meta: { approvalId: "a1" } }, info)).toEqual({
      resultType: "complete",
      content: [],
      _meta: { approvalId: "a1", [META_SERVER_INFO]: info },
    });
  });
  test("discover result: supportedVersions + same capabilities object + serverInfo + cache hints", () => {
    const capabilities = { tools: { listChanged: true } };
    const d = buildDiscoverResult({ capabilities, serverInfo: info, instructions: "hi" });
    expect(d).toEqual({
      resultType: "complete",
      supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      capabilities,
      _meta: { [META_SERVER_INFO]: info },
      instructions: "hi",
      ttlMs: 300000,
      cacheScope: "public",
    });
    expect(d.capabilities).toBe(capabilities);
  });
});

describe("CORS", () => {
  test("allows the 2026-07-28 request headers, drops Mcp-Session-Id", () => {
    const h = mcpCorsAllowHeaders("x-staffpass-credential");
    for (const name of ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name", "x-staffpass-credential"]) {
      expect(h.split(", ")).toContain(name);
    }
    expect(h.toLowerCase()).not.toContain("mcp-session-id");
  });
});
