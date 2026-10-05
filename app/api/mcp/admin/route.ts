import { NextResponse } from "next/server";
import { resolveAdminCredential } from "@/lib/auth/admin-credential";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/tools";
import {
  ADMIN_MCP_SERVER_NAME,
  ADMIN_MCP_SERVER_TITLE,
  ADMIN_MCP_SERVER_VERSION,
  STAFFPASS_ADMIN_MCP_URL,
} from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOLS_LIST_CACHE,
  buildDiscoverResult,
  checkMcpProtocolRequest,
  mcpCorsAllowHeaders,
  negotiateInitializeVersion,
  shapeModernResult,
} from "@/lib/mcp/protocol-negotiation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // MCP 2026-07-28 request headers. No Mcp-Session-Id: this server never mints sessions.
    "Access-Control-Allow-Headers": mcpCorsAllowHeaders("x-staffpass-admin-credential"),
    "Cache-Control": "no-store",
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { status, headers: corsHeaders() }
  );
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
  httpStatus = 200
) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } },
    { status: httpStatus, headers: corsHeaders() }
  );
}

function serverInfo() {
  return {
    name: ADMIN_MCP_SERVER_NAME,
    version: ADMIN_MCP_SERVER_VERSION,
    title: ADMIN_MCP_SERVER_TITLE,
    description:
      "Staffpass Admin MCP — tenant admin mouth (hire / link / policy / parties / channels / roles.propose). Always human. Not the employee badge MCP.",
    websiteUrl: "https://staffpass.sealith.com",
    mcpEndpoint: STAFFPASS_ADMIN_MCP_URL,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: ADMIN_MCP_TOOLS.map((t) => t.name),
    supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    auth: {
      type: "bearer",
      scheme: "Authorization: Bearer gb_adm_…",
      alternateHeader: "x-staffpass-admin-credential",
      notEmployeeBadge: true,
      employeeBadgeHeader: "gb_emp_ is rejected (fail-closed)",
    },
  };
}

/** Server identity for initialize `serverInfo` and modern `_meta` serverInfo. */
function serverIdentity() {
  return {
    name: ADMIN_MCP_SERVER_NAME,
    version: ADMIN_MCP_SERVER_VERSION,
    title: ADMIN_MCP_SERVER_TITLE,
  };
}

/**
 * The one capabilities object for initialize AND server/discover (keep them
 * identical: add new capabilities here only).
 */
function serverCapabilities(): Record<string, unknown> {
  return { tools: { listChanged: true } };
}

function serverInstructions(): string {
  return "Staffpass Admin MCP is a separate mouth from the employee badge MCP. Authenticate with Authorization: Bearer gb_adm_… — never gb_emp_. All tools are always_human: they create an approval ticket and do not mutate until a different human approves. Do not mix with staffpass_whoami / staffpass_invoke.";
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET() {
  return NextResponse.json(serverInfo(), { headers: corsHeaders() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | JsonRpcRequest
    | JsonRpcRequest[]
    | null;

  if (!body) {
    return jsonRpcError(null, -32700, "Parse error", undefined, 400);
  }
  if (Array.isArray(body)) {
    return jsonRpcError(null, -32600, "Batch requests are not supported", undefined, 400);
  }

  const id = (body.id ?? null) as JsonRpcId;
  const method = typeof body.method === "string" ? body.method.trim() : "";
  const params = (body.params || {}) as Record<string, unknown>;

  if (!method) {
    // Non-string / missing method → Invalid Request; echo id only if it is a valid JSON-RPC id.
    const safeId = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    return jsonRpcError(safeId, -32600, "Invalid Request: method required", undefined, 400);
  }
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: corsHeaders() });
  }

  // MCP 2026-07-28: header ↔ body validation + era (lib/mcp/protocol-negotiation.ts).
  // Runs before auth and before any work; never reflects header / _meta values.
  const protocol = checkMcpProtocolRequest(req, method, params);
  if (!protocol.ok) {
    return jsonRpcError(id, protocol.code, protocol.message, protocol.data, protocol.httpStatus);
  }
  const modern = protocol.era === "modern";
  const reply = (result: Record<string, unknown>) =>
    jsonRpcResult(id, modern ? shapeModernResult(result, serverIdentity()) : result);

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: negotiateInitializeVersion(params.protocolVersion),
      capabilities: serverCapabilities(),
      serverInfo: serverIdentity(),
      instructions: serverInstructions(),
    });
  }

  // Public metadata, same as initialize (no credential), any era.
  if (method === "server/discover") {
    return jsonRpcResult(
      id,
      buildDiscoverResult({
        capabilities: serverCapabilities(),
        serverInfo: serverIdentity(),
        instructions: serverInstructions(),
      })
    );
  }

  if (method === "ping") {
    return reply({});
  }

  if (method === "tools/list" || method === "tools/call") {
    const auth = await resolveAdminCredential(req);
    if (!auth.ok) {
      return jsonRpcError(
        id,
        -32001,
        auth.message,
        { code: auth.code },
        auth.httpStatus
      );
    }

    if (method === "tools/list") {
      return reply({
        tools: ADMIN_MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        ...(modern ? MCP_TOOLS_LIST_CACHE : {}),
      });
    }

    const toolName = String(params.name || "").trim();
    const toolArgs =
      params.arguments &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const meta =
      params._meta &&
      typeof params._meta === "object" &&
      !Array.isArray(params._meta)
        ? (params._meta as Record<string, unknown>)
        : null;
    const approvalId =
      (typeof toolArgs.approvalId === "string" ? toolArgs.approvalId.trim() : "") ||
      (meta && typeof meta.approvalId === "string" ? meta.approvalId.trim() : "") ||
      (typeof params.approvalId === "string" ? params.approvalId.trim() : "");
    if (approvalId && !toolArgs.approvalId) {
      toolArgs.approvalId = approvalId;
    }
    if (!toolName) {
      return jsonRpcError(id, -32602, "tools/call requires params.name");
    }
    try {
      const result = await callAdminMcpTool(toolName, toolArgs, auth.credential);
      return reply(result as Record<string, unknown>);
    } catch (e) {
      const message = e instanceof Error ? e.message : "tool_call_failed";
      return jsonRpcError(id, -32000, message, undefined, 500);
    }
  }

  // Modern requests: unknown method → HTTP 404 (spec). Legacy: HTTP 200 as before.
  return jsonRpcError(id, -32601, `Method not found: ${method}`, undefined, modern ? 404 : 200);
}
