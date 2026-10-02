import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  classifyModernRequest,
  decodeMcpHeaderValue,
  MCP_ERR_HEADER_MISMATCH,
  MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION,
} from "./modern";
import { checkProtocolVersionHeader } from "./protocol";

const ENV = ["MCP_PROTOCOL_NEGOTIATION_ENABLED", "MCP_PROTOCOL_MODERN_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
const on = () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  process.env.MCP_PROTOCOL_MODERN_ENABLED = "1";
};
const META = (v: unknown) => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientCapabilities": {} } });
const req = (h: Record<string, string>) => new Request("https://x/api/mcp", { method: "POST", headers: h });
const modernHeaders = (method: string, extra: Record<string, string> = {}) => ({
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  ...extra,
});

test("flag OFF (either flag) → never modern; header 2026-07-28 not accepted by negotiation alone", () => {
  expect(classifyModernRequest(req(modernHeaders("tools/list")), "tools/list", META("2026-07-28"))).toEqual({ modern: false });
  process.env.MCP_PROTOCOL_MODERN_ENABLED = "1"; // without negotiation
  expect(classifyModernRequest(req(modernHeaders("tools/list")), "tools/list", META("2026-07-28"))).toEqual({ modern: false });
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  delete process.env.MCP_PROTOCOL_MODERN_ENABLED;
  expect(checkProtocolVersionHeader(req({ "mcp-protocol-version": "2026-07-28" })).ok).toBe(false);
});

test("ON: header accepts 2026-07-28 via registerExtraHeaderVersions", () => {
  on();
  expect(checkProtocolVersionHeader(req({ "mcp-protocol-version": "2026-07-28" }))).toEqual({ ok: true, version: "2026-07-28", explicit: true });
});

test("ON: legacy requests (no _meta version, legacy header, initialize) stay legacy", () => {
  on();
  expect(classifyModernRequest(req({}), "tools/list", {})).toEqual({ modern: false });
  expect(classifyModernRequest(req({ "mcp-protocol-version": "2025-11-25" }), "tools/list", META("2025-11-25"))).toEqual({ modern: false });
  expect(classifyModernRequest(req(modernHeaders("initialize")), "initialize", META("2026-07-28"))).toEqual({ modern: false });
});

test("ON: valid modern tools/list and tools/call (plain + base64 Mcp-Name)", () => {
  on();
  expect(classifyModernRequest(req(modernHeaders("tools/list")), "tools/list", META("2026-07-28"))).toEqual({ modern: true, ok: true, version: "2026-07-28" });
  const call = { ...META("2026-07-28"), name: "staffpass_whoami" };
  expect(classifyModernRequest(req(modernHeaders("tools/call", { "mcp-name": "staffpass_whoami" })), "tools/call", call)).toMatchObject({ ok: true });
  const b64 = `=?base64?${Buffer.from("staffpass_whoami").toString("base64")}?=`;
  expect(classifyModernRequest(req(modernHeaders("tools/call", { "mcp-name": b64 })), "tools/call", call)).toMatchObject({ ok: true });
});

test("ON: HeaderMismatch (-32020) cases", () => {
  on();
  const call = { ...META("2026-07-28"), name: "staffpass_invoke" };
  const cases: Array<[Record<string, string>, string, Record<string, unknown>]> = [
    [{ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }, "tools/list", {}], // header modern, body missing version
    [{ "mcp-method": "tools/list" }, "tools/list", META("2026-07-28")], // body modern, header missing
    [{ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }, "tools/list", META("2099-01-01")], // header≠body
    [{ "mcp-protocol-version": "2026-07-28" }, "tools/list", META("2026-07-28")], // Mcp-Method missing
    [modernHeaders("tools/list"), "tools/call", call], // Mcp-Method ≠ body
    [modernHeaders("tools/call"), "tools/call", call], // Mcp-Name missing
    [modernHeaders("tools/call", { "mcp-name": "staffpass_whoami" }), "tools/call", call], // Mcp-Name ≠ body (routing spoof)
    [modernHeaders("tools/call", { "mcp-name": "=?base64?***?=" }), "tools/call", call], // malformed sentinel
  ];
  for (const [h, m, p] of cases) {
    const r = classifyModernRequest(req(h), m, p);
    expect(r).toMatchObject({ modern: true, ok: false, code: MCP_ERR_HEADER_MISMATCH });
  }
});

test("ON: unknown modern version (header==body) → -32022 with supported + requested", () => {
  on();
  const r = classifyModernRequest(req({ "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" }), "tools/list", META("2099-01-01"));
  expect(r).toMatchObject({ modern: true, ok: false, code: MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION });
  if (r.modern && !r.ok) {
    expect(r.data?.requested).toBe("2099-01-01");
    expect(r.data?.supported).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
  }
});

test("decodeMcpHeaderValue: plain, base64 non-ASCII, rejects bad padding / control chars / bare sentinel prefix", () => {
  expect(decodeMcpHeaderValue("tool_a")).toBe("tool_a");
  expect(decodeMcpHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe("Hello, 世界");
  expect(decodeMcpHeaderValue(" padded ")).toBeNull();
  expect(decodeMcpHeaderValue("=?base64?notclosed")).toBeNull();
  expect(decodeMcpHeaderValue("=?base64?/w==?=")).toBeNull(); // invalid UTF-8
  expect(decodeMcpHeaderValue("")).toBeNull();
});
