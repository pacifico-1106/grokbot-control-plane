/**
 * MCP protocol version negotiation + tools/list presentation helpers.
 * Every behavior change here is gated by MCP_PROTOCOL_NEGOTIATION_ENABLED
 * (lib/feature-flags.ts). Flag OFF → callers keep the legacy fixed 2024-11-05.
 */
import { isMcpProtocolNegotiationEnabled } from "@/lib/feature-flags";

/** Legacy fixed version answered when negotiation is OFF. */
export const MCP_LEGACY_FIXED_VERSION = "2024-11-05";

/** initialize-era (legacy) versions we can speak, newest first. */
export const MCP_SUPPORTED_LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_LATEST_LEGACY_VERSION = MCP_SUPPORTED_LEGACY_VERSIONS[0];

/**
 * Version assumed when a non-initialize request has no MCP-Protocol-Version
 * header (Streamable HTTP backwards-compat rule).
 */
export const MCP_DEFAULT_HEADER_VERSION = "2025-03-26";

export function isSupportedLegacyVersion(v: unknown): v is string {
  return (
    typeof v === "string" &&
    (MCP_SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(v)
  );
}

/**
 * Lifecycle rule: if the server supports the requested version it MUST answer
 * with the same version, otherwise it answers with the latest it supports.
 */
export function negotiateInitializeVersion(requested: unknown): string {
  if (!isMcpProtocolNegotiationEnabled()) return MCP_LEGACY_FIXED_VERSION;
  return isSupportedLegacyVersion(requested) ? requested : MCP_LATEST_LEGACY_VERSION;
}

/** Extra versions accepted on the header (PR-9 modern era plugs in here). */
let extraHeaderVersions: () => readonly string[] = () => [];
export function registerExtraHeaderVersions(fn: () => readonly string[]) {
  extraHeaderVersions = fn;
}

export type ProtocolHeaderCheck =
  | { ok: true; version: string; explicit: boolean }
  | { ok: false; version: string; message: string };

/**
 * Validate MCP-Protocol-Version. Flag OFF → always ok (header ignored, as today).
 */
export function checkProtocolVersionHeader(req: Request): ProtocolHeaderCheck {
  const raw = (req.headers.get("mcp-protocol-version") || "").trim();
  if (!isMcpProtocolNegotiationEnabled()) {
    return { ok: true, version: raw || MCP_LEGACY_FIXED_VERSION, explicit: Boolean(raw) };
  }
  if (!raw) return { ok: true, version: MCP_DEFAULT_HEADER_VERSION, explicit: false };
  if ((MCP_SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(raw) || extraHeaderVersions().includes(raw)) {
    return { ok: true, version: raw, explicit: true };
  }
  return {
    ok: false,
    version: raw.slice(0, 32),
    message: `Unsupported MCP-Protocol-Version. Supported: ${[
      ...extraHeaderVersions(),
      ...MCP_SUPPORTED_LEGACY_VERSIONS,
    ].join(", ")}`,
  };
}

/** GET asking for an SSE stream → 405 when negotiation is ON. */
export function wantsSseStream(req: Request): boolean {
  if (!isMcpProtocolNegotiationEnabled()) return false;
  const accept = (req.headers.get("accept") || "").toLowerCase();
  return accept.includes("text/event-stream");
}

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/**
 * Presentation hints per tool. readOnlyHint:true only for tools that never
 * create tickets or side effects. Everything else stays a write so clients
 * (Cowork / ChatGPT) keep asking the human before calling it.
 */
export const MCP_TOOL_PRESENTATION: Record<string, { title: string; annotations: McpToolAnnotations }> = {
  staffpass_whoami: {
    title: "Who am I (employee badge)",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  staffpass_profile: {
    title: "Employee profile",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  staffpass_get_approval_status: {
    title: "Get approval status",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  staffpass_health: {
    title: "Badge health",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  staffpass_stuck_list: {
    title: "List stuck items",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  staffpass_invoke: {
    title: "Invoke Gateway tool (approval-gated)",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  staffpass_stuck_retry: {
    title: "Retry stuck item",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  staffpass_decision_request: {
    title: "Request a decision (稟議)",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  staffpass_config_change_request: {
    title: "Request a config change",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
};

type ListableTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
};

/**
 * tools/list entries. Flag OFF → exactly {name, description, inputSchema}
 * (byte-identical to the pre-negotiation response).
 */
export function presentToolsForList(tools: ListableTool[]): Array<Record<string, unknown>> {
  const enriched = isMcpProtocolNegotiationEnabled();
  return tools.map((t) => {
    const base: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    };
    if (!enriched) return base;
    const p = MCP_TOOL_PRESENTATION[t.name];
    if (p) {
      base.title = p.title;
      base.annotations = { title: p.title, ...p.annotations };
    } else {
      // Unknown tool → conservative: write, may touch the outside world.
      base.annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
    }
    if (t.outputSchema) base.outputSchema = t.outputSchema;
    if (t._meta) base._meta = t._meta;
    return base;
  });
}

/**
 * Origin check (MUST in 2026-07-28; DNS-rebinding defense). v1 = log only,
 * never block: bearer-auth public server. Allowlist: MCP_ALLOWED_ORIGINS (csv).
 * Logs only the origin host — never headers or tokens.
 */
export function noteUnexpectedOrigin(req: Request, surface: string): void {
  if (!isMcpProtocolNegotiationEnabled()) return;
  const origin = (req.headers.get("origin") || "").trim();
  if (!origin) return;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0 || allowed.includes(origin)) return;
  let host = "invalid";
  try {
    host = new URL(origin).host;
  } catch {
    /* keep invalid */
  }
  console.warn(`[mcp] unexpected Origin host on ${surface}: ${host}`);
}
