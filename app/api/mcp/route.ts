import { NextResponse } from "next/server";
import { isMcpOAuthLegacyUnauthInitialize } from "@/lib/feature-flags";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import {
  hasAnyMcpCredential,
  resolveMcpCredential,
  wwwAuthenticate,
} from "@/lib/mcp-oauth/resource-server";
import {
  callStaffpassMcpTool,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  listStaffpassMcpTools,
} from "@/lib/mcp/tools";
import { STAFFPASS_MCP_URL } from "@/lib/mcp/public";
import { isConfigChangeRequestEnabled } from "@/lib/feature-flags";
import {
  checkProtocolVersionHeader,
  negotiateInitializeVersion,
  noteUnexpectedOrigin,
  presentToolsForList,
  wantsSseStream,
} from "@/lib/mcp/protocol";

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
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Mcp-Session-Id, x-staffpass-credential",
    "Access-Control-Expose-Headers": isMcpOAuthEnabled()
      ? "Mcp-Session-Id, WWW-Authenticate"
      : "Mcp-Session-Id",
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
  httpStatus = 200,
  extraHeaders?: Record<string, string>
) {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data },
    },
    { status: httpStatus, headers: { ...corsHeaders(), ...(extraHeaders ?? {}) } }
  );
}

function serverInfo() {
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    title: "Staffpass",
    description:
      "Staffpass remote MCP — AI employee control plane (whoami, invoke, approval poll, health). Fail-closed Gateway enforcement; confirm/send/order require human approval.",
    websiteUrl: "https://staffpass.sealith.com",
    mcpEndpoint: STAFFPASS_MCP_URL,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: listStaffpassMcpTools().map((t) => t.name),
    auth: {
      type: "bearer",
      scheme: "Authorization: Bearer gb_emp_…",
      alternateHeader: "x-staffpass-credential",
    },
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** GET — server card / discovery (no secret). */
export async function GET(req: Request) {
  if (wantsSseStream(req)) {
    // Streamable HTTP: server either opens an SSE stream or answers 405.
    return new NextResponse(null, {
      status: 405,
      headers: { ...corsHeaders(), Allow: "GET, POST, OPTIONS" },
    });
  }
  return NextResponse.json(serverInfo(), { headers: corsHeaders() });
}

/**
 * Streamable HTTP JSON-RPC MCP (POST).
 * Auth required for tools/list and tools/call.
 */
export async function POST(req: Request) {
  noteUnexpectedOrigin(req, "/api/mcp");
  const body = (await req.json().catch(() => null)) as
    | JsonRpcRequest
    | JsonRpcRequest[]
    | null;

  if (!body) {
    return jsonRpcError(null, -32700, "Parse error", undefined, 400);
  }

  if (Array.isArray(body)) {
    return jsonRpcError(
      null,
      -32600,
      "Batch requests are not supported",
      undefined,
      400
    );
  }

  const id = (body.id ?? null) as JsonRpcId;
  const method = (body.method || "").trim();
  const params = (body.params || {}) as Record<string, unknown>;

  if (!method) {
    return jsonRpcError(id, -32600, "Invalid Request: method required", undefined, 400);
  }

  const protocolHeader = checkProtocolVersionHeader(req);
  if (!protocolHeader.ok) {
    return jsonRpcError(
      id,
      -32600,
      protocolHeader.message,
      { requested: protocolHeader.version },
      400
    );
  }

  // OAuth ON: every unauthenticated request gets 401 + WWW-Authenticate so
  // Claude / ChatGPT start the sign-in flow (they ignore challenges on 200).
  if (isMcpOAuthEnabled() && !hasAnyMcpCredential(req)) {
    const lifecycle =
      method === "initialize" || method === "ping" || method.startsWith("notifications/");
    if (!(lifecycle && isMcpOAuthLegacyUnauthInitialize())) {
      return jsonRpcError(
        id,
        -32001,
        "Authentication required (OAuth 2.1 or Authorization: Bearer gb_emp_…)",
        { code: "missing_credential" },
        401,
        { "WWW-Authenticate": wwwAuthenticate() }
      );
    }
  }

  // Notifications (no response body required by JSON-RPC; return 202 empty ack)
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: corsHeaders() });
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: negotiateInitializeVersion(params.protocolVersion),
      capabilities: {
        tools: { listChanged: true },
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      instructions:
        "Staffpass is a fail-closed AI employee control plane. Authenticate with Authorization: Bearer gb_emp_…. Use staffpass_whoami then staffpass_invoke with purpose+jobId. On needs_approval, poll staffpass_get_approval_status with approvalId+statusToken (pollUrl in the result) until approved|rejected|revision_requested|expired — do not complete confirm/send/order while pending. On revision_requested, revise per revisionNote and re-invoke with the same jobId and parentApprovalId. Restrict clients with allowed_tools to the four staffpass_* tools." +
        (isConfigChangeRequestEnabled()
          ? " Never change your own Instructions/policy text or channel ledger/classification yourself: file staffpass_config_change_request and wait for the human approver; approvers/permissions/billing are not requestable."
          : ""),
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  // tools/* require employee badge
  if (method === "tools/list" || method === "tools/call") {
    const auth = await resolveMcpCredential(req);
    if (!auth.ok) {
      const challenge =
        isMcpOAuthEnabled() && auth.httpStatus === 401
          ? {
              "WWW-Authenticate": wwwAuthenticate(
                hasAnyMcpCredential(req) ? { error: "invalid_token", description: auth.code } : {}
              ),
            }
          : undefined;
      return jsonRpcError(
        id,
        -32001,
        auth.message,
        { code: auth.code },
        auth.httpStatus,
        challenge
      );
    }

    if (method === "tools/list") {
      return jsonRpcResult(id, {
        tools: presentToolsForList(listStaffpassMcpTools()),
      });
    }

    const toolName = String(params.name || "").trim();
    const toolArgs =
      params.arguments &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    if (!toolName) {
      return jsonRpcError(id, -32602, "tools/call requires params.name");
    }

    try {
      const result = await callStaffpassMcpTool(
        toolName,
        toolArgs,
        auth.credential
      );
      return jsonRpcResult(id, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "tool_call_failed";
      return jsonRpcError(id, -32000, message, undefined, 500);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
