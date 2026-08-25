import { NextResponse } from "next/server";
import { resolveEmployeeCredential } from "@/lib/auth/employee-credential";
import {
  callStaffpassMcpTool,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  STAFFPASS_MCP_TOOLS,
} from "@/lib/mcp/tools";
import { STAFFPASS_MCP_URL } from "@/lib/mcp/public";

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
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
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
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data },
    },
    { status: httpStatus, headers: corsHeaders() }
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
    tools: STAFFPASS_MCP_TOOLS.map((t) => t.name),
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
export async function GET() {
  return NextResponse.json(serverInfo(), { headers: corsHeaders() });
}

/**
 * Streamable HTTP JSON-RPC MCP (POST).
 * Auth required for tools/list and tools/call.
 */
export async function POST(req: Request) {
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

  // Notifications (no response body required by JSON-RPC; return 202 empty ack)
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: corsHeaders() });
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      instructions:
        "Staffpass is a fail-closed AI employee control plane. Authenticate with Authorization: Bearer gb_emp_…. Use staffpass_whoami then staffpass_invoke with purpose+jobId. On needs_approval, poll staffpass_get_approval_status with approvalId+statusToken (pollUrl in the result) until approved|rejected|expired — do not complete confirm/send/order while pending. Restrict clients with allowed_tools to the four staffpass_* tools.",
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  // tools/* require employee badge
  if (method === "tools/list" || method === "tools/call") {
    const auth = await resolveEmployeeCredential(req);
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
      return jsonRpcResult(id, {
        tools: STAFFPASS_MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
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
