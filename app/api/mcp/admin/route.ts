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
      "Authorization, Content-Type, Accept, Mcp-Session-Id, x-staffpass-admin-credential",
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
    auth: {
      type: "bearer",
      scheme: "Authorization: Bearer gb_adm_…",
      alternateHeader: "x-staffpass-admin-credential",
      notEmployeeBadge: true,
      employeeBadgeHeader: "gb_emp_ is rejected (fail-closed)",
    },
  };
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
  const method = (body.method || "").trim();
  const params = (body.params || {}) as Record<string, unknown>;

  if (!method) {
    return jsonRpcError(id, -32600, "Invalid Request: method required", undefined, 400);
  }
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: corsHeaders() });
  }

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: ADMIN_MCP_SERVER_NAME,
        version: ADMIN_MCP_SERVER_VERSION,
        title: ADMIN_MCP_SERVER_TITLE,
      },
      instructions:
        "Staffpass Admin MCP is a separate mouth from the employee badge MCP. Authenticate with Authorization: Bearer gb_adm_… — never gb_emp_. All tools are always_human: they create an approval ticket and do not mutate until a different human approves. Do not mix with staffpass_whoami / staffpass_invoke.",
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
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
      return jsonRpcResult(id, {
        tools: ADMIN_MCP_TOOLS.map((t) => ({
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
      const result = await callAdminMcpTool(toolName, toolArgs, auth.credential);
      return jsonRpcResult(id, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "tool_call_failed";
      return jsonRpcError(id, -32000, message, undefined, 500);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
