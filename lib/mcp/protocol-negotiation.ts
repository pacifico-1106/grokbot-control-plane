/**
 * MCP protocol version support for /api/mcp (employee badge) and /api/mcp/admin.
 *
 * Dual-era server (MCP 2026-07-28, basic/versioning "Backward Compatibility"):
 * - `initialize` selects legacy (initialize-era) semantics. The answer follows
 *   the legacy lifecycle rule: echo the requested version if supported,
 *   otherwise the latest initialize-era version we support.
 * - A request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` is a
 *   modern (2026-07-28) request and is served statelessly; `server/discover`
 *   advertises every supported version and the server capabilities.
 *
 * Streamable HTTP request headers (basic/transports/streamable-http):
 * - `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` must match the body; a
 *   mismatch is answered with HTTP 400 + JSON-RPC -32020 (HeaderMismatch).
 * - An unsupported per-request version → HTTP 400 + -32022
 *   (UnsupportedProtocolVersionError) listing the supported versions.
 * - Missing headers on a modern request are rejected only when
 *   MCP_STRICT_REQUEST_HEADERS is ON (default OFF; see lib/feature-flags.ts).
 *
 * `_meta` is size-bounded and only these keys are ever read:
 * io.modelcontextprotocol/protocolVersion and clientCapabilities (presence).
 * Nothing from `_meta` or the headers is reflected in responses, except a
 * requested version that has the YYYY-MM-DD shape (UnsupportedProtocolVersion
 * `data.requested`, as the spec example shows).
 */
import { isMcpStrictRequestHeadersEnabled } from "@/lib/feature-flags";

/** Modern (per-request `_meta`) revisions, newest first. */
export const MCP_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
/** Initialize-era revisions, newest first (2024-11-05 … 2025-11-25). */
export const MCP_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Everything we speak, newest first (server/discover `supportedVersions`). */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MCP_MODERN_PROTOCOL_VERSIONS,
  ...MCP_LEGACY_PROTOCOL_VERSIONS,
];
export const MCP_LATEST_PROTOCOL_VERSION = MCP_MODERN_PROTOCOL_VERSIONS[0];
export const MCP_LATEST_LEGACY_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSIONS[0];
/** Answer to an initialize without protocolVersion (unchanged from before 2026-07-28 support). */
export const MCP_INITIALIZE_DEFAULT_VERSION = "2024-11-05";

/** JSON-RPC error codes reserved by the MCP spec (-32020 … -32099). */
export const MCP_ERR_HEADER_MISMATCH = -32020;
export const MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const JSONRPC_INVALID_PARAMS = -32602;

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** `params._meta` bounds (serialized JSON bytes / top-level keys). */
export const MCP_META_MAX_BYTES = 16 * 1024;
export const MCP_META_MAX_KEYS = 64;

/** Cache hints for modern results (CacheableResult). */
export const MCP_DISCOVER_CACHE = { ttlMs: 300_000, cacheScope: "public" as const };
/** tools/list is behind the credential → private (never cached by shared intermediaries). */
export const MCP_TOOLS_LIST_CACHE = { ttlMs: 300_000, cacheScope: "private" as const };

function isOneOf(list: readonly string[], v: unknown): v is string {
  return typeof v === "string" && list.includes(v);
}

export function isSupportedProtocolVersion(v: unknown): v is string {
  return isOneOf(MCP_SUPPORTED_PROTOCOL_VERSIONS, v);
}

/**
 * initialize: echo a supported initialize-era version, otherwise answer the
 * latest initialize-era version (2025-11-25). 2026-07-28 has no initialize, so
 * a client asking for it here is answered with 2025-11-25 and can keep using
 * legacy semantics (or switch to per-request `_meta`, which we also serve).
 */
export function negotiateInitializeVersion(requested: unknown): string {
  if (typeof requested !== "string") return MCP_INITIALIZE_DEFAULT_VERSION;
  return isOneOf(MCP_LEGACY_PROTOCOL_VERSIONS, requested) ? requested : MCP_LATEST_LEGACY_PROTOCOL_VERSION;
}

const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
// Header-safe printable ASCII without leading/trailing whitespace.
const SAFE_PLAIN = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;
const MAX_HEADER_VALUE = 1024;

/** Decode an Mcp-Name value (plain ASCII or `=?base64?…?=`). null → malformed. */
export function decodeMcpHeaderValue(raw: string): string | null {
  if (!raw || raw.length > MAX_HEADER_VALUE) return null;
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

/** Methods whose Mcp-Name header mirrors a body field. */
const NAME_FIELD: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

export type McpProtocolCheck =
  | { ok: true; era: "legacy" | "modern"; version: string | null }
  | {
      ok: false;
      httpStatus: 400;
      code: number;
      message: string;
      data?: Record<string, unknown>;
    };

function fail(code: number, message: string, data?: Record<string, unknown>): McpProtocolCheck {
  return data ? { ok: false, httpStatus: 400, code, message, data } : { ok: false, httpStatus: 400, code, message };
}

function headerMismatch(detail: string): McpProtocolCheck {
  return fail(MCP_ERR_HEADER_MISMATCH, `Header mismatch: ${detail}`);
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function unsupportedProtocolVersion(requested: unknown): McpProtocolCheck {
  const data: Record<string, unknown> = { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS] };
  if (typeof requested === "string" && DATE_SHAPE.test(requested)) data.requested = requested;
  return fail(MCP_ERR_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", data);
}

function readMeta(params: Record<string, unknown>): { meta: Record<string, unknown> } | { tooLarge: true } {
  const raw = params?._meta;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { meta: {} };
  const meta = raw as Record<string, unknown>;
  if (Object.keys(meta).length > MCP_META_MAX_KEYS) return { tooLarge: true };
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(meta), "utf8");
  } catch {
    return { tooLarge: true };
  }
  if (size > MCP_META_MAX_BYTES) return { tooLarge: true };
  return { meta };
}

/**
 * Validate one JSON-RPC request (not notifications) against the Streamable
 * HTTP header rules and decide its era. Call before auth and before any work.
 */
export function checkMcpProtocolRequest(
  req: Request,
  method: string,
  params: Record<string, unknown>,
  opts: { strict?: boolean } = {}
): McpProtocolCheck {
  const strict = opts.strict ?? isMcpStrictRequestHeadersEnabled();

  const metaRead = readMeta(params);
  if ("tooLarge" in metaRead) {
    return fail(
      JSONRPC_INVALID_PARAMS,
      `Invalid params: params._meta exceeds ${MCP_META_MAX_BYTES} bytes or ${MCP_META_MAX_KEYS} keys`
    );
  }
  const meta = metaRead.meta;

  // Mirrored headers must match the body whenever they are present (any era).
  const methodHeader = req.headers.get("mcp-method");
  if (methodHeader !== null && methodHeader.trim() !== method) {
    return headerMismatch("Mcp-Method header does not match the request method");
  }
  const nameField = NAME_FIELD[method];
  const nameHeader = req.headers.get("mcp-name");
  if (nameField && nameHeader !== null) {
    const decoded = decodeMcpHeaderValue(nameHeader.trim());
    if (decoded === null) return headerMismatch("Mcp-Name header value is malformed");
    if (decoded !== params?.[nameField]) {
      return headerMismatch(`Mcp-Name header does not match params.${nameField}`);
    }
  }

  // initialize always selects legacy semantics (dual-era rule).
  if (method === "initialize") return { ok: true, era: "legacy", version: null };

  const versionHeaderRaw = req.headers.get("mcp-protocol-version");
  const versionHeader = versionHeaderRaw === null ? null : versionHeaderRaw.trim();
  const hasBodyVersion = Object.prototype.hasOwnProperty.call(meta, META_PROTOCOL_VERSION);
  const bodyVersion = meta[META_PROTOCOL_VERSION];

  if (hasBodyVersion) {
    if (typeof bodyVersion !== "string" || !bodyVersion) {
      return fail(JSONRPC_INVALID_PARAMS, `Invalid params: _meta["${META_PROTOCOL_VERSION}"] must be a non-empty string`);
    }
    if (versionHeader !== null && versionHeader !== bodyVersion) {
      return headerMismatch(`MCP-Protocol-Version header does not match _meta["${META_PROTOCOL_VERSION}"]`);
    }
    if (versionHeader === null && strict) {
      return headerMismatch("MCP-Protocol-Version header is required");
    }
    if (!isSupportedProtocolVersion(bodyVersion)) return unsupportedProtocolVersion(bodyVersion);
    if (!isOneOf(MCP_MODERN_PROTOCOL_VERSIONS, bodyVersion)) {
      // A supported initialize-era version in `_meta`: serve with legacy shapes.
      return { ok: true, era: "legacy", version: bodyVersion };
    }
    if (strict) {
      if (methodHeader === null) return headerMismatch("Mcp-Method header is required");
      if (nameField && nameHeader === null) return headerMismatch("Mcp-Name header is required");
      if (!Object.prototype.hasOwnProperty.call(meta, META_CLIENT_CAPABILITIES)) {
        return fail(JSONRPC_INVALID_PARAMS, `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] is required`);
      }
    }
    return { ok: true, era: "modern", version: bodyVersion };
  }

  // No per-request version in the body.
  if (versionHeader === null || versionHeader === "") {
    return { ok: true, era: "legacy", version: null };
  }
  if (isOneOf(MCP_MODERN_PROTOCOL_VERSIONS, versionHeader)) {
    if (strict) {
      return fail(JSONRPC_INVALID_PARAMS, `Invalid params: _meta["${META_PROTOCOL_VERSION}"] is required`);
    }
    return { ok: true, era: "modern", version: versionHeader };
  }
  if (isOneOf(MCP_LEGACY_PROTOCOL_VERSIONS, versionHeader)) {
    return { ok: true, era: "legacy", version: versionHeader };
  }
  // Unknown header version on an initialize-era request: ignored as before,
  // unless strict.
  if (strict) return unsupportedProtocolVersion(versionHeader);
  return { ok: true, era: "legacy", version: null };
}

export type McpServerIdentity = { name: string; version: string; title?: string };

/** Modern results MUST carry resultType; servers SHOULD add serverInfo to `_meta`. */
export function shapeModernResult(
  result: Record<string, unknown>,
  serverInfo: McpServerIdentity
): Record<string, unknown> {
  const existing =
    result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
      ? (result._meta as Record<string, unknown>)
      : {};
  return {
    resultType: "complete",
    ...result,
    _meta: { ...existing, [META_SERVER_INFO]: serverInfo },
  };
}

/**
 * server/discover result. `capabilities` must be the same object initialize
 * returns (each route builds it once in serverCapabilities()).
 */
export function buildDiscoverResult(input: {
  capabilities: Record<string, unknown>;
  serverInfo: McpServerIdentity;
  instructions: string;
}) {
  return {
    resultType: "complete" as const,
    supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: input.capabilities,
    _meta: { [META_SERVER_INFO]: input.serverInfo },
    instructions: input.instructions,
    ...MCP_DISCOVER_CACHE,
  };
}

/** CORS Access-Control-Allow-Headers for an MCP endpoint (+ its credential header). */
export function mcpCorsAllowHeaders(credentialHeader: string): string {
  return ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name", credentialHeader].join(", ");
}
