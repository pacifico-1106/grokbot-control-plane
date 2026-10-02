/**
 * MCP 2026-07-28 ("modern", stateless) era support — dual-era server.
 * Gated by isMcpProtocolModernEnabled() (MCP_PROTOCOL_MODERN_ENABLED +
 * MCP_PROTOCOL_NEGOTIATION_ENABLED). Flag OFF → classifyModernRequest()
 * returns { modern: false } and nothing else here is reached.
 *
 * Spec refs (2026-07-28): basic/versioning, basic/transports/streamable-http
 * (Server Validation, Value Encoding), server/discover.
 */
import { isMcpProtocolModernEnabled } from "@/lib/feature-flags";
import {
  MCP_SUPPORTED_LEGACY_VERSIONS,
  registerExtraHeaderVersions,
} from "@/lib/mcp/protocol";

export const MCP_MODERN_VERSIONS = ["2026-07-28"] as const;
export const MCP_LATEST_MODERN_VERSION = MCP_MODERN_VERSIONS[0];

export const MCP_ERR_HEADER_MISMATCH = -32020;
export const MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** tools/list cache hint: tools only change on deploy; list is behind auth → private. */
export const MODERN_TOOLS_LIST_TTL_MS = 300_000;

registerExtraHeaderVersions(() => (isMcpProtocolModernEnabled() ? MCP_MODERN_VERSIONS : []));

export function isModernVersion(v: unknown): v is string {
  return typeof v === "string" && (MCP_MODERN_VERSIONS as readonly string[]).includes(v);
}

function isLegacyVersion(v: unknown): boolean {
  return typeof v === "string" && (MCP_SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(v);
}

/** Modern first, then legacy (reachable via initialize). */
export function allSupportedVersions(): string[] {
  return [...MCP_MODERN_VERSIONS, ...MCP_SUPPORTED_LEGACY_VERSIONS];
}

const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
// Header-safe printable ASCII without leading/trailing whitespace.
const SAFE_PLAIN = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

/** Decode an Mcp-Name value (plain or =?base64?…?=). null → malformed. */
export function decodeMcpHeaderValue(raw: string): string | null {
  const m = SENTINEL.exec(raw);
  if (m) {
    try {
      const buf = Buffer.from(m[1], "base64");
      if (buf.toString("base64").replace(/=+$/, "") !== m[1].replace(/=+$/, "")) return null;
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }
  if (raw.startsWith("=?base64?")) return null;
  return SAFE_PLAIN.test(raw) ? raw : null;
}

const NAME_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

export type ModernClassification =
  | { modern: false }
  | { modern: true; ok: true; version: string }
  | { modern: true; ok: false; code: number; message: string; data?: Record<string, unknown> };

function clip(v: string): string {
  return v.length > 64 ? `${v.slice(0, 64)}…` : v;
}

function mismatch(message: string): ModernClassification {
  return { modern: true, ok: false, code: MCP_ERR_HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

/**
 * Decide whether a POST is a modern-era request and validate it.
 * Modern = body `_meta[protocolVersion]` is not a legacy version, or the
 * MCP-Protocol-Version header names a modern version. initialize is always
 * legacy (dual-era rule: initialize selects legacy semantics).
 */
export function classifyModernRequest(
  req: Request,
  method: string,
  params: Record<string, unknown>
): ModernClassification {
  if (!isMcpProtocolModernEnabled() || method === "initialize") return { modern: false };
  const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? (params._meta as Record<string, unknown>)
    : {};
  const bodyVersion = meta[META_PROTOCOL_VERSION];
  const headerVersion = (req.headers.get("mcp-protocol-version") || "").trim();
  const bodyIsModernCandidate = bodyVersion !== undefined && !isLegacyVersion(bodyVersion);
  if (!bodyIsModernCandidate && !isModernVersion(headerVersion)) return { modern: false };

  if (typeof bodyVersion !== "string" || !bodyVersion) {
    return mismatch(`MCP-Protocol-Version header '${clip(headerVersion)}' has no matching _meta["${META_PROTOCOL_VERSION}"] in the body`);
  }
  if (!headerVersion) return mismatch("MCP-Protocol-Version header is required");
  if (headerVersion !== bodyVersion) {
    return mismatch(`MCP-Protocol-Version header value '${clip(headerVersion)}' does not match body value '${clip(bodyVersion)}'`);
  }
  if (!isModernVersion(bodyVersion)) {
    return {
      modern: true,
      ok: false,
      code: MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION,
      message: "Unsupported protocol version",
      data: { supported: allSupportedVersions(), requested: clip(bodyVersion) },
    };
  }

  const methodHeader = req.headers.get("mcp-method");
  if (methodHeader === null) return mismatch("Mcp-Method header is required");
  if (methodHeader.trim() !== method) {
    return mismatch(`Mcp-Method header value '${clip(methodHeader.trim())}' does not match body value '${clip(method)}'`);
  }

  const nameField = NAME_METHODS[method];
  if (nameField) {
    const rawName = req.headers.get("mcp-name");
    if (rawName === null) return mismatch("Mcp-Name header is required");
    const decoded = decodeMcpHeaderValue(rawName.trim());
    if (decoded === null) return mismatch("Mcp-Name header value is malformed");
    const bodyName = params[nameField];
    if (typeof bodyName !== "string" || decoded !== bodyName) {
      return mismatch(`Mcp-Name header value does not match body params.${nameField}`);
    }
  }
  return { modern: true, ok: true, version: bodyVersion };
}

/** Unsupported MCP-Protocol-Version header (modern ON) → -32022 body. */
export function unsupportedHeaderVersionError(requested: string) {
  return {
    code: MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION,
    message: "Unsupported protocol version",
    data: { supported: allSupportedVersions(), requested: clip(requested) },
  };
}

export function buildDiscoverResult(input: {
  name: string;
  version: string;
  instructions: string;
}) {
  return {
    resultType: "complete",
    supportedVersions: allSupportedVersions(),
    capabilities: { tools: {} },
    _meta: { [META_SERVER_INFO]: { name: input.name, version: input.version } },
    instructions: input.instructions,
    ttlMs: 3_600_000,
    cacheScope: "public" as const,
  };
}

/** Modern results MUST carry resultType. */
export function modernResult<T extends Record<string, unknown>>(result: T): T & { resultType: string } {
  return { resultType: "complete", ...result };
}

export const MODERN_CORS_ALLOW_HEADERS = "MCP-Protocol-Version, Mcp-Method, Mcp-Name";
