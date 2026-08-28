/**
 * Staffpass remote MCP tool surface (narrow control-plane only).
 * Confirm/send/order always stop for human approval via shared Gateway invoke.
 */
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import {
  getApprovalStatusByToken,
  getBinding,
  getEmployeeById,
  runtimeModeLabel,
} from "@/lib/data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import {
  isDemoMode,
  isResendConfigured,
  isStripeConfigured,
} from "@/lib/mode";
import type { GatewayInvokeRequest } from "@/lib/types";
import { buildStaffpassWhoamiPayload } from "@/lib/mcp/whoami";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "staffpass";
export const MCP_SERVER_VERSION = "1.0.0";

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export const STAFFPASS_MCP_TOOLS: McpToolDef[] = [
  {
    name: "staffpass_whoami",
    description:
      "Return the authenticated AI employee badge identity: employeeId, displayName, orgId, binding status, credential generation, scopes, allowedPurposes, and voice (character/register). External destinations cannot drop below the polite floor — whoami returns the badge voice; Gateway applies externalFloor when the destination is external. Use before invoking tools. Fail-closed if unbound or needs_reauth. Do not self-declare a persona.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "staffpass_invoke",
    description:
      "Invoke a Staffpass Gateway tool under the employee badge. Requires purpose + jobId. Unknown tools are rejected. Confirm/send/order (and always_human policy) STOP for human approval — the result includes approvalId, statusToken, pollUrl, pollHint, title, and summary so you can poll without relying on prose Instructions. Re-invoke with approvalId after status=approved. Never bypasses Gateway enforcement.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description:
            "Gateway tool id (e.g. mail.draft, mail.send, calendar.propose, calendar.confirm, commerce.order, tools.ping).",
        },
        purpose: {
          type: "string",
          description:
            "Job purpose key; must be in credential.allowedPurposes when that list is set.",
        },
        jobId: {
          type: "string",
          description: "Correlation id for this job (required).",
        },
        approvalId: {
          type: "string",
          description:
            "Prior human approval id after poll returns approved; unlocks confirm/send/order completion.",
        },
        parentApprovalId: {
          type: "string",
          description:
            "Approval id whose status is revision_requested. Use it when submitting the corrected artifact with the same jobId.",
        },
        amountJpy: {
          type: "number",
          description: "Order amount in JPY (commerce.order).",
        },
        commerceAuthorization: {
          type: "object",
          description:
            "Optional structured JPYC authorization for Sealith correlation. This records authority only and never marks payment complete.",
          additionalProperties: true,
        },
        payload: {
          type: "object",
          description:
            "Optional tool args (claimedAccount, service, accountId, isFirstOrder, conversation, informationClass, disclosure).",
          additionalProperties: true,
        },
        conversation: {
          type: "object",
          description:
            "Optional conversation context (surface + destination identifiers). Old clients may omit; slack/comm without destination fail-closed as external.",
          additionalProperties: true,
        },
        informationClass: {
          type: "string",
          description: "public | internal | confidential | verbatim. Unclassified assets default to confidential.",
        },
        disclosure: {
          type: "string",
          description: "summary | source. Calendar busy/free defaults to summary.",
        },
      },
      required: ["tool", "purpose", "jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "staffpass_get_approval_status",
    description:
      "Poll a human approval ticket with approvalId + statusToken (same as GET /api/approvals/status). Returns pending|approved|rejected|revision_requested|expired and pollHint. On revision_requested, revise per revisionNote and re-invoke with the same jobId and parentApprovalId.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: {
          type: "string",
          description: "Approval ticket id from needs_approval result.",
        },
        statusToken: {
          type: "string",
          description: "Opaque status token from needs_approval result.",
        },
      },
      required: ["approvalId", "statusToken"],
      additionalProperties: false,
    },
  },
  {
    name: "staffpass_health",
    description:
      "Runtime health for this employee badge: runtimeMode, supabase/stripe/resend flags, and binding health (linked / unbound / needs_reauth).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function toolResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
    isError,
  };
}

export async function callStaffpassMcpTool(
  name: string,
  args: Record<string, unknown>,
  cred: ResolvedEmployeeCredential
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  switch (name) {
    case "staffpass_whoami": {
      const employee = await getEmployeeById(cred.employeeId);
      const binding = (await getBinding(cred.employeeId)) ?? cred.binding;
      if (!employee) {
        return toolResult(
          {
            ok: false,
            code: "employee_not_found",
            message: "employee not found (fail-closed)",
          },
          true
        );
      }
      return toolResult(
        buildStaffpassWhoamiPayload({
          employee,
          orgId: cred.orgId || employee.orgId,
          binding,
          generation: cred.generation,
        })
      );
    }
    case "staffpass_invoke": {
      const tool = String(args.tool || "").trim();
      const purpose = String(args.purpose || "").trim();
      const jobId = String(args.jobId || args.job_id || "").trim();
      const approvalId =
        typeof args.approvalId === "string" ? args.approvalId.trim() : undefined;
      const parentApprovalId =
        typeof args.parentApprovalId === "string"
          ? args.parentApprovalId.trim()
          : undefined;
      const amountJpy =
        args.amountJpy == null ? undefined : Number(args.amountJpy);
      const payload =
        args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
          ? (args.payload as Record<string, unknown>)
          : {};

      const body: GatewayInvokeRequest = {
        employeeId: cred.employeeId,
        tool,
        purpose,
        jobId,
        approvalId,
        parentApprovalId,
        amountJpy: Number.isFinite(amountJpy as number)
          ? (amountJpy as number)
          : undefined,
        commerceAuthorization:
          args.commerceAuthorization &&
          typeof args.commerceAuthorization === "object" &&
          !Array.isArray(args.commerceAuthorization)
            ? (args.commerceAuthorization as GatewayInvokeRequest["commerceAuthorization"])
            : payload.commerceAuthorization &&
                typeof payload.commerceAuthorization === "object" &&
                !Array.isArray(payload.commerceAuthorization)
              ? (payload.commerceAuthorization as GatewayInvokeRequest["commerceAuthorization"])
              : undefined,
        args: payload,
        claimedAccount:
          payload.claimedAccount && typeof payload.claimedAccount === "object"
            ? (payload.claimedAccount as { service?: string; accountId?: string })
            : undefined,
        service: typeof payload.service === "string" ? payload.service : undefined,
        accountId:
          typeof payload.accountId === "string" ? payload.accountId : undefined,
        isFirstOrder:
          typeof payload.isFirstOrder === "boolean"
            ? payload.isFirstOrder
            : undefined,
        spentTodayJpy:
          typeof payload.spentTodayJpy === "number"
            ? payload.spentTodayJpy
            : undefined,
        spentThisMonthJpy:
          typeof payload.spentThisMonthJpy === "number"
            ? payload.spentThisMonthJpy
            : undefined,
        conversation:
          args.conversation && typeof args.conversation === "object" && !Array.isArray(args.conversation)
            ? (args.conversation as GatewayInvokeRequest["conversation"])
            : payload.conversation && typeof payload.conversation === "object" && !Array.isArray(payload.conversation)
              ? (payload.conversation as GatewayInvokeRequest["conversation"])
              : undefined,
        informationClass:
          typeof args.informationClass === "string"
            ? (args.informationClass as GatewayInvokeRequest["informationClass"])
            : typeof payload.informationClass === "string"
              ? (payload.informationClass as GatewayInvokeRequest["informationClass"])
              : undefined,
        disclosure:
          typeof args.disclosure === "string"
            ? (args.disclosure as GatewayInvokeRequest["disclosure"])
            : typeof payload.disclosure === "string"
              ? (payload.disclosure as GatewayInvokeRequest["disclosure"])
              : undefined,
        surface: typeof args.surface === "string" ? (args.surface as GatewayInvokeRequest["surface"]) : undefined,
        slackChannelId:
          typeof args.slackChannelId === "string"
            ? args.slackChannelId
            : typeof payload.slackChannelId === "string"
              ? payload.slackChannelId
              : undefined,
        slackUserId:
          typeof args.slackUserId === "string"
            ? args.slackUserId
            : typeof payload.slackUserId === "string"
              ? payload.slackUserId
              : undefined,
        email: typeof args.email === "string" ? args.email : typeof payload.email === "string" ? payload.email : undefined,
        phone: typeof args.phone === "string" ? args.phone : undefined,
        lineId: typeof args.lineId === "string" ? args.lineId : undefined,
      };

      const result = await runGatewayInvoke({
        employeeId: cred.employeeId,
        body,
        credentialId: cred.credentialId,
      });

      // Ensure approval return pipe fields are always present on needs_approval.
      const out = { ...result.body };
      if (out.needs_approval === true || out.code === "needs_approval") {
        if (!("pollHint" in out)) out.pollHint = "continue_polling";
        if (!("approvalId" in out)) out.approvalId = null;
        if (!("statusToken" in out)) out.statusToken = null;
        if (!("pollUrl" in out)) out.pollUrl = null;
        if (!("title" in out)) out.title = null;
        if (!("summary" in out)) out.summary = null;
      }

      const isError = result.httpStatus >= 400 && out.code !== "needs_approval";
      // needs_approval is a controlled stop, not a transport error — still return as tool result.
      return toolResult(out, isError && out.code !== "needs_approval");
    }
    case "staffpass_get_approval_status": {
      const approvalId = String(args.approvalId || args.id || "").trim();
      const statusToken = String(
        args.statusToken || args.token || ""
      ).trim();
      if (!approvalId || !statusToken) {
        return toolResult(
          {
            ok: false,
            error: "id_and_token_required",
            message: "approvalId and statusToken are required",
          },
          true
        );
      }
      const approval = await getApprovalStatusByToken(approvalId, statusToken);
      if (!approval) {
        return toolResult(
          { ok: false, error: "not_found_or_invalid_token" },
          true
        );
      }
      const status =
        approval.status === "approved" ||
        approval.status === "rejected" ||
        approval.status === "pending" ||
        approval.status === "expired"
        || approval.status === "revision_requested"
          ? approval.status
          : "pending";
      return toolResult({
        ok: true,
        demo: runtimeModeLabel() === "demo",
        mode: runtimeModeLabel(),
        approvalId: approval.id,
        status,
        title: approval.title,
        summary: approval.summary,
        tool: approval.tool ?? null,
        purpose: approval.purpose,
        jobId: approval.jobId ?? null,
        risk: approval.risk,
        employeeId: approval.employeeId,
        createdAt: approval.createdAt,
        resolvedAt: approval.resolvedAt,
        revisionNote: approval.revisionNote,
        revisionCount: approval.revisionCount,
        parentApprovalId: approval.parentApprovalId,
        pollHint:
          status === "pending"
            ? "continue_polling"
            : status === "approved"
              ? "reinvoke_with_approvalId"
              : status === "revision_requested"
                ? `Revise the artifact per revisionNote and re-invoke with the same jobId and parentApprovalId=${approval.id}.`
              : "abort_job",
      });
    }
    case "staffpass_health": {
      const binding = (await getBinding(cred.employeeId)) ?? cred.binding;
      const runtimeMode = runtimeModeLabel();
      return toolResult({
        ok: true,
        runtimeMode,
        demo: isDemoMode(),
        supabaseConfigured: !isDemoMode(),
        stripeConfigured: isStripeConfigured(),
        resendConfigured: isResendConfigured(),
        employeeId: cred.employeeId,
        orgId: cred.orgId,
        generation: cred.generation,
        binding: binding
          ? {
              status: binding.status,
              grokBotAgentId: binding.grokBotAgentId,
              lastSuccessAt: binding.lastSuccessAt,
              lastError: binding.lastError,
              credentialGeneration: binding.credentialGeneration,
            }
          : null,
        mcpEndpoint: "/api/mcp",
        gatewayEndpoint: "/api/gateway/invoke",
        publicOrigin: "https://staffpass.sealith.com",
      });
    }
    default:
      return toolResult(
        {
          ok: false,
          code: "unknown_mcp_tool",
          message: `Unknown MCP tool: ${name}. Allowed: staffpass_whoami, staffpass_invoke, staffpass_get_approval_status, staffpass_health`,
        },
        true
      );
  }
}
