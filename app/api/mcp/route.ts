import { NextResponse } from "next/server";
import { resolveEmployeeCredential } from "@/lib/auth/employee-credential";
import { maybeLogUnauthInitialize } from "@/lib/mcp/unauth-init-log";
import {
  callStaffpassMcpTool,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  listStaffpassMcpTools,
} from "@/lib/mcp/tools";
import { STAFFPASS_MCP_URL } from "@/lib/mcp/public";
import { isConfigChangeRequestEnabled, isMcpEventsEnabled } from "@/lib/feature-flags";
import { recordMcpClientSeen } from "@/lib/mcp/endpoint-handoff";
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
    "Access-Control-Allow-Headers": mcpCorsAllowHeaders("x-staffpass-credential"),
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
    tools: listStaffpassMcpTools().map((t) => t.name),
    supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    auth: {
      type: "bearer",
      scheme: "Authorization: Bearer gb_emp_…",
      alternateHeader: "x-staffpass-credential",
    },
  };
}

/** Server identity for initialize `serverInfo` and modern `_meta` serverInfo. */
function serverIdentity() {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/**
 * The one capabilities object for initialize AND server/discover (keep them
 * identical: add new capabilities here only).
 */
function serverCapabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: true },
    // MCP Events (#267; flag MCP_EVENTS_ENABLED OFF → absent). Lives here so
    // initialize and server/discover always advertise the same thing.
    ...(isMcpEventsEnabled() ? { events: {} } : {}),
  };
}

function serverInstructions(): string {
  return (
    "Staffpass is a fail-closed AI employee control plane. Authenticate with Authorization: Bearer gb_emp_…. Use staffpass_whoami then staffpass_invoke with purpose+jobId. On needs_approval, poll staffpass_get_approval_status with approvalId+statusToken (pollUrl in the result) until approved|rejected|revision_requested|expired — do not complete confirm/send/order while pending. On revision_requested, revise per revisionNote and re-invoke with the same jobId and parentApprovalId. Restrict clients with allowed_tools to the four staffpass_* tools." +
    (isConfigChangeRequestEnabled()
      ? " Never change your own Instructions/policy text or channel ledger/classification yourself: file staffpass_config_change_request and wait for the human approver; approvers/permissions/billing are not requestable."
      : "")
  );
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
    maybeLogUnauthInitialize(req, params);
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

  // MCP Events (flag MCP_EVENTS_ENABLED; OFF → falls through to the final
  // -32601 below, which stays the LAST branch: HTTP 404 for modern requests).
  // Same badge as tools/*; unauthenticated → -32012 Forbidden (spec), HTTP 401/403.
  // Results go through reply(): modern (2026-07-28 _meta) requests get the same
  // shape as tools/* (resultType, _meta serverInfo); legacy requests unchanged.
  if (isMcpEventsEnabled() && (method === "events/list" || method === "events/subscribe" || method === "events/unsubscribe")) {
    const auth = await resolveEmployeeCredential(req);
    if (!auth.ok) {
      return jsonRpcError(id, -32012, "Forbidden", { code: auth.code }, auth.httpStatus);
    }
    const events = await import("@/lib/mcp-events/service");
    try {
      const out =
        method === "events/list"
          ? await events.handleEventsList(auth.credential)
          : method === "events/subscribe"
            ? await events.handleEventsSubscribe(auth.credential, params)
            : await events.handleEventsUnsubscribe(auth.credential, params);
      return out.ok ? reply(out.result as Record<string, unknown>) : jsonRpcError(id, out.code, out.message, out.data);
    } catch {
      return jsonRpcError(id, -32603, "Internal error", undefined, 500);
    }
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

    // MCP endpoint handoff: "the bot reached Staffpass MCP with its badge" signal
    // (flag-gated, throttled, never stores the secret). Best-effort.
    await recordMcpClientSeen(
      auth.credential,
      method,
      method === "tools/call" ? String(params.name || "").trim() : undefined
    ).catch(() => undefined);

    if (method === "tools/list") {
      return reply({
        tools: listStaffpassMcpTools().map((t) => ({
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

    if (!toolName) {
      return jsonRpcError(id, -32602, "tools/call requires params.name");
    }

    // MCP Events: link the first tool call after a delivery to that event
    // ("what woke the AI"). Flag OFF → no-op. Best-effort.
    if (isMcpEventsEnabled()) {
      await import("@/lib/mcp-events/service")
        .then((events) => events.recordTriggeredAction(auth.credential, toolName))
        .catch(() => undefined);
    }

    try {
      const result = await callStaffpassMcpTool(
        toolName,
        toolArgs,
        auth.credential
      );
      return reply(result as Record<string, unknown>);
    } catch (e) {
      const message = e instanceof Error ? e.message : "tool_call_failed";
      return jsonRpcError(id, -32000, message, undefined, 500);
    }
  }

  // Modern requests: unknown method → HTTP 404 (spec). Legacy: HTTP 200 as before.
  return jsonRpcError(id, -32601, `Method not found: ${method}`, undefined, modern ? 404 : 200);
}
