/**
 * Staffpass Admin MCP tools (separate mouth from employee badge MCP).
 * All tools are always_human. Do not mix with staffpass_whoami / invoke / poll / health.
 */
import type { McpToolDef } from "@/lib/mcp/tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { getApprovalById, getBinding, getEmployee } from "@/lib/data";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { buildEmployeePolicyDrafts } from "@/lib/employees/policy-draft";
import { parseRolesProposeInput } from "@/lib/mcp/roles-propose";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";

export const ADMIN_MCP_TOOLS: McpToolDef[] = [
  {
    name: "employees.issue",
    description:
      "Issue an AI employee badge after human approval (always_human). Call roles.propose first to get human-confirmed role drafts, then issue with those drafts. After issue succeeds, tell the human to prepare one Grok Bot and call link with grokBotAgentId. Staffpass only issues/links badges — creating Grok bots is out of scope. Admin cannot self-approve or grant itself extra scopes.",
    inputSchema: {
      type: "object",
      properties: {
        displayName: { type: "string" },
        roleLabel: { type: "string" },
        jobDescription: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        allowedPurposes: { type: "array", items: { type: "string" } },
        approvalPolicy: { type: "string" },
        actionLimits: { type: "object", additionalProperties: true },
        spend: { type: "object", additionalProperties: true },
        allowedAccounts: { type: "array" },
        jobId: { type: "string" },
      },
      required: ["displayName", "roleLabel", "scopes"],
      additionalProperties: true,
    },
  },
  {
    name: "link",
    description:
      "Bind grokBotAgentId to an existing employee badge after human approval (always_human). Human must prepare one Grok Bot on the agent side first. After link succeeds, proceed to connector OAuth (human taps, separate from approval tickets). Does not create Grok bots. Admin cannot self-approve.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        grokBotAgentId: { type: "string" },
        grokBotWorkspaceId: { type: "string" },
        jobId: { type: "string" },
      },
      required: ["employeeId", "grokBotAgentId"],
      additionalProperties: false,
    },
  },
  {
    name: "policy.patch",
    description:
      "Patch an employee policy (scopes / purposes / actionLimits) after human approval (always_human). Admin cannot grant itself extra scopes. Dashboard humans cannot edit these fields.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        allowedPurposes: { type: "array", items: { type: "string" } },
        approvalPolicy: { type: "string" },
        actionLimits: { type: "object", additionalProperties: true },
        jobId: { type: "string" },
      },
      required: ["employeeId", "scopes", "approvalPolicy"],
      additionalProperties: true,
    },
  },
  {
    name: "parties.upsert",
    description:
      "Upsert an org party (audience directory) after human approval (always_human). Separate audit class from mail.send / comm.reply.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        identifier: { type: "string" },
        audience: { type: "string", description: "internal | external" },
        jobId: { type: "string" },
      },
      required: ["kind", "identifier"],
      additionalProperties: false,
    },
  },
  {
    name: "channels.classify",
    description:
      "Classify a conversation channel (internal / shared_external / unknown) after human approval (always_human). For an internal Slack 1:1 (D... IM), employeeId installs that employee's mention-free Staffpass-app DM ingress at fulfillment. Omitting employeeId removes the IM ingress (fail-closed). Channels and groups remain mention-triggered.",
    inputSchema: {
      type: "object",
      properties: {
        surface: { type: "string" },
        externalId: { type: "string" },
        identifier: { type: "string" },
        classification: { type: "string" },
        mixed: { type: "boolean" },
        employeeId: { type: "string", description: "Bound employee for an internal Slack 1:1 only" },
        slackTeamId: { type: "string", description: "Slack workspace id when known" },
        jobId: { type: "string" },
      },
      required: ["externalId"],
      additionalProperties: false,
    },
  },
  {
    name: "roles.propose",
    description:
      "Propose employee role drafts from PROCESS SOURCE (always_human). Human confirms the first edition of role drafts. After approval, proceed to employees.issue with the confirmed drafts. sourceType is document | voice | text. At least one of text, location, or transcript is required. Drive is optional and must not fail the tool. Document, Drive/Supabase location, voice/transcript, and free text (including conversation logs) are the same class. Admin cannot self-approve. Not available on employee MCP.",
    inputSchema: {
      type: "object",
      properties: {
        sourceType: { type: "string", description: "document | voice | text" },
        text: { type: "string", description: "Document body, conversation log, or free text" },
        location: { type: "string", description: "Drive / Supabase / other location (optional)" },
        transcript: { type: "string", description: "Voice transcript" },
        documentText: { type: "string" },
        driveLocation: { type: "string" },
        supabaseLocation: { type: "string" },
        conversationLog: { type: "string" },
        jobHint: { type: "string" },
        jobId: { type: "string" },
      },
      additionalProperties: true,
    },
  },
];

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError,
  };
}

function adminCannotTargetSelf(
  cred: ResolvedAdminCredential,
  grokBotAgentId: string | null | undefined
): boolean {
  const mine = (cred.grokBotAgentId || "").trim();
  const theirs = (grokBotAgentId || "").trim();
  return Boolean(mine && theirs && mine === theirs);
}

export function isAdminMcpToolName(name: string): boolean {
  return (ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

export function adminToolsAlwaysHuman(): boolean {
  return true;
}

export async function callAdminMcpTool(
  name: string,
  args: Record<string, unknown>,
  cred: ResolvedAdminCredential
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}> {
  if (!isAdminMcpToolName(name)) {
    return toolResult(
      {
        ok: false,
        code: "unknown_mcp_tool",
        message: `Unknown admin MCP tool: ${name}`,
      },
      true
    );
  }

  if (name === "policy.patch" || name === "link") {
    const employeeId = String(args.employeeId || "").trim();
    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
      const binding = await getBinding(employeeId);
      if (adminCannotTargetSelf(cred, binding?.grokBotAgentId)) {
        return toolResult(
          {
            ok: false,
            code: "cannot_grant_self_scopes",
            message: "管理エージェントは自分へ権限を足せません",
          },
          true
        );
      }
    }
  }

  if (name === "link" && adminCannotTargetSelf(cred, String(args.grokBotAgentId || ""))) {
    return toolResult(
      {
        ok: false,
        code: "cannot_grant_self_scopes",
        message: "管理エージェントは自分を社員証に紐づけできません",
      },
      true
    );
  }

  if (name === "employees.issue") {
    const scopes = Array.isArray(args.scopes) ? args.scopes.map(String) : [];
    if (!String(args.displayName || "").trim() || !String(args.roleLabel || "").trim()) {
      return toolResult(
        { ok: false, code: "name_and_role_required", message: "名前と職務は必須です" },
        true
      );
    }
    if (!scopes.length || scopes.some((scope) => !ALL_SCOPES.includes(scope as (typeof ALL_SCOPES)[number]))) {
      return toolResult(
        { ok: false, code: "scopes_required", message: "できることを1つ以上選んでください" },
        true
      );
    }
  }

  let queuedArgs = { ...args };
  let summary = `${name} の実行を人が確認します`;

  if (name === "roles.propose") {
    const parsed = parseRolesProposeInput(args);
    if (!parsed.ok) {
      return toolResult(
        {
          ok: false,
          code: parsed.code,
          message: parsed.message,
          driveRequired: false,
        },
        true
      );
    }
    const drafts = parsed.value.combinedText
      ? buildEmployeePolicyDrafts(parsed.value.combinedText)
      : [];
    queuedArgs = {
      sourceType: parsed.value.sourceType,
      text: parsed.value.text || null,
      location: parsed.value.location || null,
      transcript: parsed.value.transcript || null,
      combinedText: parsed.value.combinedText,
      driveWired: false,
      draft: drafts[0] ?? null,
      drafts,
      jobId: args.jobId,
    };
    summary = `職務案の提案を人が確認します（${parsed.value.sourceType} · ${drafts[0]?.policy.roleLabel ?? "案"}）`;
  } else if (name === "employees.issue") {
    summary = `${String(args.displayName)}（${String(args.roleLabel)}）の発行を人が確認します`;
  } else if (name === "policy.patch") {
    summary = `権限の更新を人が確認します（${String(args.employeeId)}）`;
  } else if (name === "parties.upsert") {
    summary = `相手台帳の更新を人が確認します（${String(args.identifier)}）`;
  } else if (name === "channels.classify") {
    summary = `チャネル分類を人が確認します（${String(args.externalId || args.identifier)}）`;
  } else if (name === "link") {
    summary = `連携を人が確認します（${String(args.employeeId)}）`;
  }

  const queued = await queueAdminTool({
    cred,
    tool: name,
    args: queuedArgs,
    summary,
  });
  return toolResult(queued, false);
}

export async function readApprovedAdminResult(
  cred: ResolvedAdminCredential,
  approvalId: string
): Promise<Record<string, unknown> | null> {
  const approval = await getApprovalById(approvalId, cred.orgId);
  if (!approval || approval.status !== "approved") return null;
  const fulfillment = parseAdminFulfillment(approval.metadata);
  if (!fulfillment) return null;
  const out: Record<string, unknown> = {
    ok: fulfillment.ok,
    auditClass: ADMIN_AUDIT_CLASS,
    tool: fulfillment.tool,
    employeeId: fulfillment.employeeId ?? null,
    secretPrefix: fulfillment.secretPrefix ?? null,
    partyId: fulfillment.partyId ?? null,
    channelId: fulfillment.channelId ?? null,
    draft: fulfillment.draft ?? null,
  };
  if (fulfillment.oneTimeSecret) {
    out.oneTimeSecret = fulfillment.oneTimeSecret;
    out.noticeJa = "この秘密値は一度だけです。社員証 MCP に使い、管理 MCP のヘッダと混ぜないでください。";
  }
  if (fulfillment.nextStepJa) {
    out.nextStepJa = fulfillment.nextStepJa;
  }
  if (fulfillment.noticeJa && !out.noticeJa) {
    out.noticeJa = fulfillment.noticeJa;
  }
  return out;
}
