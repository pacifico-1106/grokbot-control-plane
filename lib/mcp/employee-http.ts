import { NextResponse } from "next/server";
import { withHoldCallScope } from "@/lib/safety/hold";
import { resolveEmployeeCredential } from "@/lib/auth/employee-credential";
import { mcpAuthFailureErrorData, mcpAuthFailureKind } from "@/lib/auth/mcp-auth-failure";
import { recordMcpAuthFailure } from "@/lib/data/mcp-auth-failures";
import { isConfigChangeRequestEnabled, isEmployeeBadgeMcpEnabled, isMcpEventsEnabled, isMcpOAuthLegacyUnauthInitialize } from "@/lib/feature-flags";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import {
  BADGE_AUTH_NEXT_STEP_JA,
  looksLikeBadgeAuthAttempt,
  shouldAdvertiseOAuthChallenge,
} from "@/lib/mcp/badge-auth-attempt";
import {
  STAFFPASS_PROFILE_TOOL_NAME,
  authChallengeMeta,
  decorateToolsForOAuth,
  oauthInstructions,
  oauthServerCardAuth,
} from "@/lib/mcp-oauth/client-compat";
import { hasAnyMcpCredential, resolveMcpCredential, wwwAuthenticate } from "@/lib/mcp-oauth/resource-server";
import { maybeLogUnauthInitialize } from "@/lib/mcp/unauth-init-log";
import {
  callStaffpassMcpTool,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  listStaffpassMcpTools,
} from "@/lib/mcp/tools";
import { STAFFPASS_MCP_EMPLOYEE_URL, STAFFPASS_MCP_URL } from "@/lib/mcp/public";
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
import { jsonUtf8 } from "@/lib/http/json-utf8";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type EmployeeMcpSurface = "shared" | "badge_only";

function corsHeaders(surface: EmployeeMcpSurface = "shared"): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // MCP 2026-07-28 request headers. No Mcp-Session-Id: this server never mints sessions.
    "Access-Control-Allow-Headers": mcpCorsAllowHeaders("x-staffpass-credential"),
    // OAuth ON only: browsers may read the challenge (flag OFF → header absent, as before).
    // Badge-only mouth never exposes WWW-Authenticate.
    ...(isMcpOAuthEnabled() && surface === "shared" ? { "Access-Control-Expose-Headers": "WWW-Authenticate" } : {}),
    "Cache-Control": "no-store",
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown, status = 200, surface: EmployeeMcpSurface = "shared") {
  return jsonUtf8(
    { jsonrpc: "2.0", id: id ?? null, result },
    { status, headers: corsHeaders(surface) }
  );
}

async function auditMcpAuthFailure(
  auth: { code: string; orgId?: string; employeeId?: string; credentialId?: string },
  method: string
): Promise<void> {
  const kind = mcpAuthFailureKind(auth.code);
  if (!kind) return;
  await recordMcpAuthFailure({
    kind,
    orgId: auth.orgId,
    employeeId: auth.employeeId,
    credentialId: auth.credentialId,
    method,
  });
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
  httpStatus = 200,
  extraHeaders?: Record<string, string>,
  surface: EmployeeMcpSurface = "shared"
) {
  return jsonUtf8(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data },
    },
    { status: httpStatus, headers: { ...corsHeaders(surface), ...(extraHeaders ?? {}) } }
  );
}

function toolsForSurface(surface: EmployeeMcpSurface) {
  const tools = listStaffpassMcpTools();
  return surface === "badge_only" ? tools.filter((t) => t.name !== STAFFPASS_PROFILE_TOOL_NAME) : tools;
}

function serverInfo(surface: EmployeeMcpSurface = "shared") {
  const advertiseOAuth = isMcpOAuthEnabled() && surface === "shared";
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    title: "Staffpass",
    description:
      "Staffpass remote MCP — AI employee control plane (whoami, invoke, approval poll, health). Fail-closed Gateway enforcement; confirm/send/order require human approval.",
    websiteUrl: "https://staffpass.sealith.com",
    mcpEndpoint: surface === "badge_only" ? STAFFPASS_MCP_EMPLOYEE_URL : STAFFPASS_MCP_URL,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: toolsForSurface(surface).map((t) => t.name),
    supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    auth: {
      type: "bearer",
      scheme: "Authorization: Bearer gb_emp_…",
      alternateHeader: "x-staffpass-credential",
      ...(advertiseOAuth ? oauthServerCardAuth() : {}),
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

function serverInstructions(surface: EmployeeMcpSurface = "shared"): string {
  const base = (
    "Staffpass is a fail-closed AI employee control plane. Authenticate with Authorization: Bearer gb_emp_…. Use staffpass_whoami then staffpass_invoke with purpose+jobId. On needs_approval, poll staffpass_get_approval_status with approvalId+statusToken (pollUrl in the result) until approved|rejected|revision_requested|expired — do not complete confirm/send/order while pending. On revision_requested, revise per revisionNote and re-invoke with the same jobId and parentApprovalId. Restrict clients with allowed_tools to the four staffpass_* tools." +
    (isConfigChangeRequestEnabled()
      ? " Never change your own Instructions/policy text or channel ledger/classification yourself: file staffpass_config_change_request and wait for the human approver; approvers/permissions/billing are not requestable."
      : "")
  );
  return isMcpOAuthEnabled() && surface === "shared" ? oauthInstructions(base) : base;
}

function attachBadgeNextStep(
  req: Request,
  surface: EmployeeMcpSurface,
  httpStatus: number,
  errorData: Record<string, unknown>
) {
  if (
    httpStatus === 401 &&
    isEmployeeBadgeMcpEnabled() &&
    (surface === "badge_only" || looksLikeBadgeAuthAttempt(req))
  ) {
    errorData.nextStepJa = BADGE_AUTH_NEXT_STEP_JA;
  }
  return errorData;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** GET — server card / discovery (no secret). */
export async function GET() {
  return jsonUtf8(serverInfo(), { headers: corsHeaders() });
}

/** Badge-only mouth (/api/mcp/employee). Callers must 404 when the flag is OFF. */
export function employeeMcpOptions() {
  return new NextResponse(null, { status: 204, headers: corsHeaders("badge_only") });
}

export function employeeMcpGet() {
  return jsonUtf8(serverInfo("badge_only"), { headers: corsHeaders("badge_only") });
}

export async function handleBadgeOnlyMcpPost(req: Request) {
  return withHoldCallScope(() => handlePost(req, "badge_only"));
}

/**
 * Streamable HTTP JSON-RPC MCP (POST).
 * Auth required for tools/list and tools/call.
 */
export async function POST(req: Request) {
  // One hold scope per call (this route takes one JSON-RPC message / one invoke): G1 → G3
  // reuse one read; G4, wake, MCP Events and just-before-send always re-read.
  return withHoldCallScope(() => handlePost(req, "shared"));
}

async function handlePost(req: Request, surface: EmployeeMcpSurface) {
  const body = (await req.json().catch(() => null)) as
    | JsonRpcRequest
    | JsonRpcRequest[]
    | null;

  if (!body) {
    return jsonRpcError(null, -32700, "Parse error", undefined, 400, undefined, surface);
  }

  if (Array.isArray(body)) {
    return jsonRpcError(
      null,
      -32600,
      "Batch requests are not supported",
      undefined,
      400,
      undefined,
      surface
    );
  }

  const id = (body.id ?? null) as JsonRpcId;
  const method = typeof body.method === "string" ? body.method.trim() : "";
  const params = (body.params || {}) as Record<string, unknown>;

  if (!method) {
    // Non-string / missing method → Invalid Request; echo id only if it is a valid JSON-RPC id.
    const safeId = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    return jsonRpcError(safeId, -32600, "Invalid Request: method required", undefined, 400, undefined, surface);
  }

  // MCP OAuth (MCP_OAUTH_ENABLED, default OFF → this block is skipped and the
  // route is byte-identical to before). With OAuth ON, a request with no
  // credential header gets 401 + WWW-Authenticate (RFC 6750 / RFC 9728) so
  // clients start the sign-in flow. Lifecycle methods (initialize / ping /
  // server/discover / notifications/*) keep today's 200/202 unless
  // MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE is explicitly false (unset = today).
  // Badge-only mouth and (flag ON) badge-shaped requests never advertise OAuth.
  if (
    surface === "shared" &&
    isMcpOAuthEnabled() &&
    !hasAnyMcpCredential(req) &&
    shouldAdvertiseOAuthChallenge(req)
  ) {
    const lifecycle =
      method === "initialize" ||
      method === "ping" ||
      method === "server/discover" ||
      method.startsWith("notifications/");
    if (!(lifecycle && isMcpOAuthLegacyUnauthInitialize())) {
      if (method === "initialize") maybeLogUnauthInitialize(req, params);
      void auditMcpAuthFailure({ code: "missing_credential" }, method);
      return jsonRpcError(
        id,
        -32001,
        "Authentication required (OAuth 2.1 or Authorization: Bearer gb_emp_…)",
        mcpAuthFailureErrorData({ code: "missing_credential" }, { _meta: authChallengeMeta() }),
        401,
        { "WWW-Authenticate": wwwAuthenticate() },
        surface
      );
    }
  }

  // Notifications (no response body required by JSON-RPC; return 202 empty ack)
  if (method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: corsHeaders(surface) });
  }

  // MCP 2026-07-28: header ↔ body validation + era (lib/mcp/protocol-negotiation.ts).
  // Runs before auth and before any work; never reflects header / _meta values.
  const protocol = checkMcpProtocolRequest(req, method, params);
  if (!protocol.ok) {
    return jsonRpcError(id, protocol.code, protocol.message, protocol.data, protocol.httpStatus, undefined, surface);
  }
  const modern = protocol.era === "modern";
  const reply = (result: Record<string, unknown>) =>
    jsonRpcResult(id, modern ? shapeModernResult(result, serverIdentity()) : result, 200, surface);

  if (method === "initialize") {
    maybeLogUnauthInitialize(req, params);
    return jsonRpcResult(id, {
      protocolVersion: negotiateInitializeVersion(params.protocolVersion),
      capabilities: serverCapabilities(),
      serverInfo: serverIdentity(),
      instructions: serverInstructions(surface),
    }, 200, surface);
  }

  // Public metadata, same as initialize (no credential), any era.
  if (method === "server/discover") {
    return jsonRpcResult(
      id,
      buildDiscoverResult({
        capabilities: serverCapabilities(),
        serverInfo: serverIdentity(),
        instructions: serverInstructions(surface),
      }),
      200,
      surface
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
      void auditMcpAuthFailure(auth, method);
      return jsonRpcError(
        id,
        -32012,
        "Forbidden",
        attachBadgeNextStep(req, surface, auth.httpStatus, mcpAuthFailureErrorData(auth)),
        auth.httpStatus,
        undefined,
        surface
      );
    }
    const events = await import("@/lib/mcp-events/service");
    try {
      const out =
        method === "events/list"
          ? await events.handleEventsList(auth.credential)
          : method === "events/subscribe"
            ? await events.handleEventsSubscribe(auth.credential, params)
            : await events.handleEventsUnsubscribe(auth.credential, params);
      return out.ok ? reply(out.result as Record<string, unknown>) : jsonRpcError(id, out.code, out.message, out.data, 200, undefined, surface);
    } catch {
      return jsonRpcError(id, -32603, "Internal error", undefined, 500, undefined, surface);
    }
  }

  // tools/* require employee badge (badge-only mouth never accepts sp_at_).
  if (method === "tools/list" || method === "tools/call") {
    const auth =
      surface === "badge_only" ? await resolveEmployeeCredential(req) : await resolveMcpCredential(req);
    if (!auth.ok) {
      void auditMcpAuthFailure(auth, method);
      const advertise = surface === "shared" && shouldAdvertiseOAuthChallenge(req);
      const challengeOpts = hasAnyMcpCredential(req) ? { error: "invalid_token" as const, description: auth.code } : {};
      const challenge =
        advertise && auth.httpStatus === 401 ? { "WWW-Authenticate": wwwAuthenticate(challengeOpts) } : undefined;
      // Body-level mirror of the HTTP challenge for clients that only surface JSON-RPC.
      const extra = challenge ? { _meta: authChallengeMeta(challengeOpts) } : undefined;
      const errorData = mcpAuthFailureErrorData(auth, extra);
      attachBadgeNextStep(req, surface, auth.httpStatus, errorData);
      return jsonRpcError(id, -32001, auth.message, errorData, auth.httpStatus, challenge, surface);
    }

    // MCP endpoint handoff: "the bot reached Staffpass MCP with its badge" signal
    // (flag-gated, throttled, never stores the secret). Best-effort.
    await recordMcpClientSeen(
      auth.credential,
      method,
      method === "tools/call" ? String(params.name || "").trim() : undefined
    ).catch(() => undefined);

    if (method === "tools/list") {
      const listed = toolsForSurface(surface).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return reply({
        tools: isMcpOAuthEnabled() && surface === "shared" ? decorateToolsForOAuth(listed) : listed,
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
      return jsonRpcError(id, -32602, "tools/call requires params.name", undefined, 200, undefined, surface);
    }

    if (surface === "badge_only" && toolName === STAFFPASS_PROFILE_TOOL_NAME) {
      return jsonRpcError(
        id,
        -32601,
        `Unknown MCP tool: ${toolName}`,
        { code: "unknown_mcp_tool" },
        200,
        undefined,
        surface
      );
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
        auth.credential,
        { surface }
      );
      return reply(result as Record<string, unknown>);
    } catch (e) {
      const message = e instanceof Error ? e.message : "tool_call_failed";
      return jsonRpcError(id, -32000, message, undefined, 500, undefined, surface);
    }
  }

  // Modern requests: unknown method → HTTP 404 (spec). Legacy: HTTP 200 as before.
  return jsonRpcError(id, -32601, `Method not found: ${method}`, undefined, modern ? 404 : 200, undefined, surface);
}
