import { consumeAdminApprovalSecret } from "@/lib/admin-mcp/consume-secret";
import { canReadAdminApproval } from "@/lib/admin-mcp/result-authority";
/**
 * Staffpass Admin MCP tools (separate mouth from employee badge MCP).
 * Most tools are always_human. Do not mix with staffpass_whoami / invoke / poll / health.
 * setup.slackStatus and ingressHandoff.get are read-only diagnostic tools that do not require approval.
 */
import type { McpToolDef } from "@/lib/mcp/tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  getApprovalById,
  getBinding,
  getEmployee,
  listNotificationChannels,
  getEffectiveIngressHandoffPolicy,
  getEffectiveSchedulingPolicy,
  type IngressHandoffPolicySource,
  type SchedulingPolicySource,
} from "@/lib/data";
import {
  validateIngressHandoffPolicy,
  summarizeIngressHandoffPolicyJa,
  nextStepIngressHandoffJa,
  policyHasHighRiskAutomation as ingressPolicyHasHighRisk,
} from "@/lib/ingress-handoff/validate";
import {
  validateSchedulingPolicy,
  summarizeSchedulingPolicyJa,
  nextStepSchedulingPolicyJa,
  policyHasHighRiskAutomation as schedulingPolicyHasHighRisk,
} from "@/lib/scheduling-policy/validate";
import {
  validateReplyPolicy,
  summarizeReplyPolicyJa,
  nextStepReplyPolicyJa,
  policyHasHighRiskAutoSend,
} from "@/lib/gateway/reply-policy-validate";
import {
  validateMailPolicy,
  summarizeMailPolicyJa,
  nextStepMailPolicyJa,
  policyHasHighRiskAutoSend as mailPolicyHasHighRiskAutoSend,
} from "@/lib/mail-policy/validate";
import { diagnoseSlackStatus, DASHBOARD_BOT_TOKEN_PATH_JA } from "@/lib/slack/slack-status-diagnose";
import {
  diagnoseConnectInternalBase,
  diagnoseChannelInternalBaseReadiness,
} from "@/lib/slack/connect-internal-base-diagnose";
import { diagnoseLineApprovalStatus } from "@/lib/line/line-approval-status-diagnose";
import { encryptNotificationSecrets } from "@/lib/notify/crypto";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { buildPollUrl } from "@/lib/approvals/tokens";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { buildEmployeePolicyDrafts } from "@/lib/employees/policy-draft";
import { parseApprovalChannelId } from "@/lib/employees/approval-inbox";
import { parseRolesProposeInput } from "@/lib/mcp/roles-propose";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { getEffectiveReplyPolicy, type ReplyPolicySource } from "@/lib/data/reply-policy";
import { getEffectiveMailPolicy, type MailPolicySource } from "@/lib/data/mail-policy";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  runStuckWatchClassify,
  runStuckWatchInspect,
  runStuckWatchList,
  runStuckWatchResolve,
  runStuckWatchRetry,
} from "@/lib/stuck-watch/admin-handlers";
import {
  getEffectiveApprovalWorkflowPolicy,
  getApprovalWorkflowProgress,
  validateApprovalWorkflowPolicy,
  summarizeApprovalWorkflowPolicyJa,
  nextStepApprovalWorkflowJa,
  type ApprovalWorkflowPolicySource,
} from "@/lib/approval-workflow";
import { assertPlatformOpsFromAdminCred } from "@/lib/admin/platform-ops-gate";
import {
  proxyResolveApproval,
  listPendingApprovalsForOrg,
  PROXY_APPROVAL_MANDATES,
  type ProxyApprovalMandate,
} from "@/lib/admin/proxy-approve";
import {
  queueOrgCreateArgs,
  validateOrgCreateInput,
  platformOrgStatus,
} from "@/lib/admin-mcp/orgs-create";
import {
  queueOrgIssueAdminCredentialArgs,
  validateOrgIssueAdminCredentialInput,
} from "@/lib/admin-mcp/orgs-issue-admin-credential";
import {
  validateOrgPatchInput,
  platformPatchOrg,
} from "@/lib/admin-mcp/orgs-patch";

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
      "Classify a conversation channel (internal / shared_external / unknown) after human approval (always_human). For an internal Slack 1:1 (D... IM), employeeId installs that employee's mention-free Staffpass-app DM ingress at fulfillment. Omitting employeeId removes the IM ingress (fail-closed). Channels and groups remain mention-triggered. 【混在ch】shared_external / Connect / ゲスト招待チャネルは mixed=true を設定し、メンバーを parties.upsert で登録（混在chは相手台帳必須）。S1 dual-audience 本番：パーティ個別解決。未登録パーティは fail-closed external。メンション要否とは別に承認判定は audience × 情報区分マトリクスで決定。",
    inputSchema: {
      type: "object",
      properties: {
        surface: { type: "string" },
        externalId: { type: "string" },
        identifier: { type: "string" },
        classification: { type: "string" },
        mixed: { type: "boolean", description: "true for shared_external / Connect / ゲスト招待。混在chは相手台帳必須" },
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
  {
    name: "setup.slackStatus",
    description:
      "Diagnose Slack integration status for this org (read-only, no approval required). Returns bot token presence, auth.test, bot files:write probe, conversation adapter status, IM routes, per-employee posting_as / Slack identity / Path B fileUploadReady, pathBReadiness aggregate, and nextStepJa (canonical order: Bot files:write→Reinstall→つながり xoxb→User files:write→社員証 Slack Authorize). Optional channelId includes Connect internal-base readiness for that channel (classify + mixed + parties/IAR coverage). No secrets returned. Use before guiding humans through Slack setup. Refer to docs/tenant-slack-kickoff-rail.md and docs/slack-file-upload-egress.md.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "Optional Slack channel ID (C...) for Connect internal-base readiness diagnosis",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "setup.slackAdapter.setBotToken",
    description:
      `Register or update the org Slack conversation posting adapter Bot token (xoxb-...) after human approval (always_human). This is the token for AI社員↔相手の会話投稿 under dashboard「${DASHBOARD_BOT_TOKEN_PATH_JA}」— NOT the approval-inbox Slack under「承認を受け取る」. Reuses the same encrypted store as PUT /api/settings/conversation-adapters. Never returns the raw token. Admin cannot self-approve. After approval, run setup.slackStatus to confirm readiness.`,
    inputSchema: {
      type: "object",
      properties: {
        botToken: {
          type: "string",
          description: "Slack Bot User OAuth Token (xoxb-...). Required when enabled=true.",
        },
        enabled: {
          type: "boolean",
          description: "Enable the Slack conversation adapter (default true). Set false to disable without a new token.",
        },
        label: {
          type: "string",
          description: "Optional display label (default: Slack 会話投稿).",
        },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "setup.connectInternalBase",
    description:
      "Diagnose Connect internal-base setup for a Slack Connect / shared_external channel (read-only, no approval required). " +
      "Returns checklist: (1) channel classify → shared_external + mixed, (2) parties or IAR configured, (3) employee post contract doc, (4) connectivity probe hint. " +
      "Each step has nextStepJa with the exact next Admin MCP tool name. " +
      "IC guidance: client cannot lower IC (raise-only), public needs information_assets + assetRef, free-text → confidential + approval. " +
      "Use for Uehara Connect / G7 cross-team wake tenant setup. Refer to docs/g7-connect-wake-routing-design-20260918.md.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "Slack Connect channel ID (C...) to diagnose. Required.",
        },
      },
      required: ["channelId"],
      additionalProperties: false,
    },
  },
  {
    name: "setup.lineApprovalStatus",
    description:
      "Diagnose org LINE approval-inbox channels under org_notification_channels (provider=line). read-only, no approval required. Returns channel readiness, Telegram collision risk, employee inbox summary, and nextStepJa for Space Tree kickoff. Never returns secrets. Confusion note: approval LINE ≠ conversation LINE (P1) ≠ Slack adapter. Refer to docs/space-tree-line-oa-design.md.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "setup.lineApproval.upsert",
    description:
      "Register or update an org LINE approval-inbox channel (channelAccessToken, channelSecret, destinationId) after human approval (always_human). Same store as dashboard「承認を受け取る」→ 承認用LINE / PUT /api/settings/notification-channels. Secrets are encrypted at rest in approval metadata only. Never returns raw tokens. NOT the conversation LINE adapter (P1) or Slack posting adapter.",
    inputSchema: {
      type: "object",
      properties: {
        channelAccessToken: {
          type: "string",
          description: "LINE Messaging API channel access token. Required when enabled=true on create.",
        },
        channelSecret: {
          type: "string",
          description: "LINE Messaging API channel secret. Required when enabled=true on create.",
        },
        destinationId: {
          type: "string",
          description: "LINE userId (U...) / groupId (C...) / roomId (R...) for approval delivery.",
        },
        allowedUserIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional allowlist of LINE userIds who may approve via webhook.",
        },
        enabled: { type: "boolean", description: "Enable the channel (default true)." },
        label: { type: "string", description: "Optional display label (default: LINE)." },
        isDefault: { type: "boolean", description: "Set as org default approval inbox." },
        channelId: { type: "string", description: "Existing org_notification_channels.id to update." },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "setup.lineApproval.setEmployeeInbox",
    description:
      "Assign an AI employee approval inbox to a LINE notification channel (or clear to org default) after human approval (always_human). Uses the same path as EmployeeApprovalInboxForm / employee policy update. approvalChannelId must be a LINE channel in this org when set.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        approvalChannelId: {
          type: "string",
          description: "LINE org_notification_channels.id, or omit/null to inherit org default.",
        },
        jobId: { type: "string" },
      },
      required: ["employeeId"],
      additionalProperties: false,
    },
  },
  {
    name: "setup.lineApproval.demoteTelegram",
    description:
      "Disable Telegram approval channels to prevent dual Telegram+LINE delivery after human approval (always_human). mode=disable disables all enabled telegram channels (optional channelId). mode=clearDefault disables telegram channels marked isDefault when LINE is the default inbox.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["disable", "clearDefault"],
          description: "disable | clearDefault",
        },
        channelId: {
          type: "string",
          description: "Optional telegram org_notification_channels.id (disable mode only).",
        },
        jobId: { type: "string" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "ingressHandoff.get",
    description:
      "Read ingress handoff policy (read-only, no approval required). D1本番稼働中。Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy (policyId/policyName) + source layer (employee/org/default) + layers (employeeOverride/orgPolicy) + hasHighRiskAutomation + highRiskConsentRecorded. Staffpass = behavior boundary; Sealith = encryption handoff. High-risk: attachment=file + sealith=off + classified_external_sensitive.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee lookup" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ingressHandoff.patch",
    description:
      "Patch ingress handoff policy after human approval (always_human). D1本番稼働中。Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Full replace of rules array. First-match rule ordering. policyId auto-generated (ihp_...), policyName human-readable. Slack wake audit: policyId/ruleId/attachmentApproval/pendingManagerApproval. Admin cannot self-approve. Convenience default: body=full, attachment=meta, sealith=off. 【高リスク警告】attachment=file + sealith=off + classified_external_sensitive は silent enable 禁止。テナント承諾 (highRiskConsentAt/By) + 監査に設定を残す。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee override" },
        clearOverride: { type: "boolean", description: "Set true to clear employee override and inherit org policy" },
        policyName: { type: "string", description: "Human-readable policy name" },
        rules: {
          type: "array",
          description: "Full replacement rules array (first match wins). Omit when clearOverride=true.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              applyTo: { type: "string", description: "all | channels | classified_external_sensitive" },
              channelIds: { type: "array", items: { type: "string" } },
              body: { type: "string", description: "full | prefix | none" },
              bodyPrefixChars: { type: "number", description: "1-4000, required when body=prefix" },
              attachment: { type: "string", description: "file | meta | none" },
              attachmentApproval: { type: "string", description: "none | manager (only when attachment!=none). manager = fail-closed until manager approves." },
              sealith: { type: "string", description: "off | suggest | required. required without transferId = fail-closed (meta only)." },
              sealithRequiredHints: { type: "array", items: { type: "string" } },
              sealithRequiredOtherText: { type: "string" },
              audit: {
                type: "object",
                properties: {
                  jobId: { type: "boolean", description: "Always true" },
                  sealithTransferId: { type: "boolean" },
                },
              },
            },
            required: ["applyTo", "body", "attachment", "sealith"],
          },
        },
        highRiskConsentAt: { type: "string", description: "ISO timestamp of tenant consent for high-risk (file+sealith=off+external) config" },
        highRiskConsentBy: { type: "string", description: "Email/name of person who gave consent" },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "schedulingPolicy.get",
    description:
      "Read scheduling policy (read-only, no approval required). Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy + source layer (employee/org/default) + layers (employeeOverride/orgPolicy). A1 scheduling.policy: 日程調整ルールパック（場所親和・移動バッファ・オンライン設定・禁止/優先時間・コスト上限・confirm自動化レベル）。confirmAutomation の高リスク設定（risk_based / conditional / full_auto）は highRiskConsentAt/By が必要。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee lookup" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "schedulingPolicy.patch",
    description:
      "Patch scheduling policy after human approval (always_human). Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Full replace of rules array. First-match rule ordering. Admin cannot self-approve. High-risk automation levels (risk_based / conditional / full_auto) require explicit tenant consent (highRiskConsentAt/By). 【高リスク警告】full_auto confirm / external 自動 / ポリシーなし自動 / 広すぎる outward slots は silent enable 禁止。承諾 + settings on audit (F4/F5)。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee override" },
        clearOverride: { type: "boolean", description: "Set true to clear employee override and inherit org policy" },
        policyName: { type: "string", description: "Human-readable policy name" },
        rules: {
          type: "array",
          description: "Full replacement rules array (first match wins). Omit when clearOverride=true.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              priority: { type: "number" },
              locationAffinity: { type: "string", description: "office_first | remote_first | hybrid | any" },
              travelBufferMinutes: { type: "number", description: "Travel buffer in minutes (0+)" },
              onlinePack: {
                type: "object",
                description: "Online meeting settings",
                properties: {
                  enabled: { type: "boolean" },
                  calendarTarget: { type: "string", description: "Target calendar for online meetings" },
                  videoToolAllowlist: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        tool: { type: "string" },
                        isDefault: { type: "boolean" },
                      },
                    },
                  },
                  defaultVideoTool: { type: "string" },
                },
              },
              hardBlackout: {
                type: "array",
                description: "Hard blackout time windows (slot will be dropped)",
                items: {
                  type: "object",
                  properties: {
                    dayOfWeek: { type: "array", items: { type: "number" }, description: "0=Sun, 6=Sat" },
                    startTime: { type: "string", description: "HH:MM" },
                    endTime: { type: "string", description: "HH:MM" },
                    startDate: { type: "string", description: "ISO date" },
                    endDate: { type: "string", description: "ISO date" },
                    reason: { type: "string" },
                  },
                },
              },
              softPrefer: {
                type: "array",
                description: "Soft prefer time windows (slot will be scored higher)",
                items: {
                  type: "object",
                  properties: {
                    dayOfWeek: { type: "array", items: { type: "number" }, description: "0=Sun, 6=Sat" },
                    startTime: { type: "string", description: "HH:MM" },
                    endTime: { type: "string", description: "HH:MM" },
                    startDate: { type: "string", description: "ISO date" },
                    endDate: { type: "string", description: "ISO date" },
                    reason: { type: "string" },
                  },
                },
              },
              costCapJpy: { type: "number", description: "Optional cost cap in JPY" },
              confirmAutomation: {
                type: "string",
                description: "always_human | risk_based | conditional | full_auto. High-risk (non-always_human) requires consent.",
              },
              calendarSources: {
                type: "object",
                description: "A1 v2: multi-calendar free/busy (union_busy). Empty ids → fail-closed escalate.",
                properties: {
                  ids: { type: "array", items: { type: "string" } },
                  freeBusyMerge: { type: "string", description: "union_busy" },
                },
              },
              meetingMode: {
                type: "object",
                description: "A1 v2: online vs in-person detection",
                properties: {
                  strategy: { type: "string", description: "title_tag | explicit_only" },
                  onlineTitleTags: { type: "array", items: { type: "string" } },
                  defaultMode: { type: "string", description: "online | in_person" },
                  onUnspecified: { type: "string", description: "drop | escalate" },
                },
              },
              areaPolicy: {
                type: "object",
                description: "A1 v2: geographic allow/deny",
                properties: {
                  allowCountries: { type: "array", items: { type: "string" } },
                  denyCountries: { type: "array", items: { type: "string" } },
                  allowRegions: { type: "array", items: { type: "string" } },
                  denyRegions: { type: "array", items: { type: "string" } },
                  onUnknownRegion: { type: "string", description: "drop | escalate | allow" },
                },
              },
              travelFeasibility: {
                type: "object",
                description: "A1 v2: static travel constraints (no routing API)",
                properties: {
                  maxOneWayMinutes: { type: "number" },
                  requireBuffer: { type: "boolean" },
                },
              },
            },
            required: ["confirmAutomation"],
          },
        },
        regionDictionary: {
          type: "object",
          description: "A1 v2: org-specific region dictionary (embedded on policy jsonb)",
          properties: {
            version: { type: "number", description: "Must be 1" },
            defaultCountry: { type: "string", description: "Default JP" },
            regions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  labelJa: { type: "string" },
                  aliases: { type: "array", items: { type: "string" } },
                  country: { type: "string" },
                },
              },
            },
          },
        },
        highRiskConsentAt: { type: "string", description: "ISO timestamp of tenant consent for high-risk automation" },
        highRiskConsentBy: { type: "string", description: "Email/name of person who gave consent" },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "replyPolicy.get",
    description:
      "Read reply policy (read-only, no approval required). Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy + source layer (employee/org/default) + layers (employeeOverride/orgPolicy). B2 reply policy: Slack/LINE返信ルールパック（営業時間外動作・絵文字/短文制御・スレッド親和性）。afterHoursMode の allow_send 設定は highRiskConsentAt/By が必要。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee lookup" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "replyPolicy.patch",
    description:
      "Patch reply policy after human approval (always_human). Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Full replace of rules array. First-match rule ordering. Admin cannot self-approve. High-risk after-hours mode (allow_send) requires explicit tenant consent (highRiskConsentAt/By). 【高リスク警告】営業時間外の自動送信は silent enable 禁止。承諾 + settings on audit (F4/F5)。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee override" },
        clearOverride: { type: "boolean", description: "Set true to clear employee override and inherit org policy" },
        policyName: { type: "string", description: "Human-readable policy name" },
        rules: {
          type: "array",
          description: "Full replacement rules array (first match wins). Omit when clearOverride=true.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              priority: { type: "number" },
              surface: { type: "string", description: "slack | line | mail | phone | web (optional, apply to all if omitted)" },
              afterHoursMode: { type: "string", description: "draft_only | allow_send | hold_approval. High-risk (allow_send) requires consent." },
              businessHours: {
                type: "object",
                description: "Business hours window",
                properties: {
                  dayOfWeek: { type: "array", items: { type: "number" }, description: "0=Sun, 6=Sat" },
                  startTime: { type: "string", description: "HH:MM" },
                  endTime: { type: "string", description: "HH:MM" },
                  timezone: { type: "string", description: "IANA timezone (default: Asia/Tokyo)" },
                },
              },
              shortReplyMode: { type: "string", description: "allow | deny | warn" },
              shortReplyMinChars: { type: "number", description: "Minimum chars for non-short reply (1-1000)" },
              emojiMode: { type: "string", description: "allow | deny | limited" },
              allowedEmojis: { type: "array", items: { type: "string" }, description: "Allowed emojis when emojiMode=limited" },
              threadAffinity: { type: "string", description: "prefer_thread | new_thread_per_topic | channel_root" },
              topicChangeThreshold: { type: "number", description: "Topic similarity threshold for new_thread_per_topic (0-1)" },
            },
            required: ["afterHoursMode", "shortReplyMode", "emojiMode", "threadAffinity"],
          },
        },
        highRiskConsentAt: { type: "string", description: "ISO timestamp of tenant consent for high-risk automation" },
        highRiskConsentBy: { type: "string", description: "Email/name of person who gave consent" },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mailPolicy.get",
    description:
      "Read mail policy (read-only, no approval required). Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy + source layer (employee/org/default) + layers (employeeOverride/orgPolicy). B1 mail policy: メール送信ルールパック（sendMode / ドメイン許可・拒否 / 添付D1継承）。sendMode auto 設定は highRiskConsentAt/By が必要。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee lookup" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mailPolicy.patch",
    description:
      "Patch mail policy after human approval (always_human). Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Full replace of rules array. First-match rule ordering. Admin cannot self-approve. sendMode auto requires explicit tenant consent (highRiskConsentAt/By). 【高リスク警告】外部宛自動送信は silent enable 禁止。承諾 + settings on audit (F4/F5)。",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee override" },
        clearOverride: { type: "boolean", description: "Set true to clear employee override and inherit org policy" },
        policyName: { type: "string", description: "Human-readable policy name" },
        rules: {
          type: "array",
          description: "Full replacement rules array (first match wins). Omit when clearOverride=true.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              priority: { type: "number" },
              audience: { type: "string", description: "internal | external | any" },
              toDomainAllowlist: { type: "array", items: { type: "string" } },
              toDomainDenylist: { type: "array", items: { type: "string" } },
              sendMode: { type: "string", description: "draft_only | needs_approval | auto" },
              draftMailbox: { type: "string" },
              requireHumanFinalSend: { type: "boolean" },
              allowCc: { type: "boolean" },
              allowBcc: { type: "boolean" },
              attachmentPolicyRef: { type: "string", description: "inherit_d1 | forbid" },
            },
            required: ["sendMode"],
          },
        },
        highRiskConsentAt: { type: "string", description: "ISO timestamp of tenant consent for high-risk automation" },
        highRiskConsentBy: { type: "string", description: "Email/name of person who gave consent" },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "internalAudienceRule.get",
    description:
      "Read org internal audience rule (read-only, no approval required). Returns the rule for stablo-scale channels: Internal = parties allowlist UNION emailDomains UNION slackTeamIds. Connect guests / unregistered → external (fail-closed). Example: #stablo_tokyo307 Connect channel with many members — registering every account via parties.upsert breaks at scale. Use org rule: own Slack team members are auto-internal.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "internalAudienceRule.patch",
    description:
      "Patch org internal audience rule after human approval (always_human). For stablo-scale channels: Internal = parties allowlist UNION emailDomains UNION slackTeamIds. Connect guests / unregistered → external (fail-closed). Example: #stablo_tokyo307 Connect channel. Set autoSlackTeamInternal=true and slackTeamIds to auto-treat own-team members as internal. Admin cannot self-approve.",
    inputSchema: {
      type: "object",
      properties: {
        emailDomains: {
          type: "array",
          items: { type: "string" },
          description: "Email domains considered internal (e.g., [\"sample-shoji.example\"])",
        },
        slackTeamIds: {
          type: "array",
          items: { type: "string" },
          description: "Slack team IDs considered internal (own workspace, e.g., [\"T01234567\"])",
        },
        autoSlackTeamInternal: {
          type: "boolean",
          description: "When true, Slack users from slackTeamIds are auto-internal. Connect guests (different team) remain fail-closed external.",
        },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.get",
    description:
      "Read stuck watch policy (read-only, no approval required). F7 Stuck Watch: faultClass mapping, W2 approved-unfulfilled watch, ops_fault auto-retry limits. Null org column returns sensible defaults.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.patch",
    description:
      "Patch org stuck watch policy after human approval (always_human). F7: enabled, mentionUnansweredMinutes, approvedUnfulfilledMinutes, maxAutoRetries, retryBackoffSeconds, autoRetryFaultClasses, notifyMouth, inferInternalAudienceFromLedger. Admin cannot self-approve.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        mentionUnansweredMinutes: { type: "number" },
        approvedUnfulfilledMinutes: { type: "number" },
        maxAutoRetries: { type: "number" },
        retryBackoffSeconds: { type: "number" },
        autoRetryFaultClasses: {
          type: "array",
          items: {
            type: "string",
            enum: ["expected_gate", "ops_fault", "config_drift"],
          },
        },
        notifyMouth: { type: "string" },
        inferInternalAudienceFromLedger: { type: "boolean" },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.list",
    description:
      "List open stuck watch items (read-only, no approval required). F7: W1 mention-unanswered + W2 approved-unfulfilled. Returns summaryJa/nextStepJa per item.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Optional filter: w1 | w2 | w1_mention_unanswered | w2_approved_unfulfilled",
        },
        includeResolved: { type: "boolean", description: "Include manually resolved items" },
        limit: { type: "number", description: "Max items (default 50, max 100)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.inspect",
    description:
      "Inspect one stuck watch item by itemId (read-only, no approval required). F7: faultClass, retry eligibility, summaryJa/nextStepJa.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Item id from stuckWatch.list (w1:... or w2:...)" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.retry",
    description:
      "Retry a stuck watch item (read-only action, no approval ticket). F7: ops_fault only auto path; expected_gate refused; config_drift notify/fix. W2 uses existing fulfill reinvoke; send/confirm re-evaluates gates.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Item id from stuckWatch.list" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.resolve",
    description:
      "Mark a stuck watch item resolved (read-only action, no approval ticket). F7: excludes item from active watch until re-detected.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Item id from stuckWatch.list" },
        note: { type: "string", description: "Optional resolution note for audit" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "stuckWatch.classify",
    description:
      "Classify faultClass + stuckHint for a stuck item or raw invoke failure code (read-only). F7: summaryJa/nextStepJa for ops vs expected_gate vs config_drift.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Item id from stuckWatch.list" },
        code: { type: "string", description: "Raw invoke failure code (when itemId omitted)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "approvalWorkflow.get",
    description:
      "Read approval workflow policy (read-only, no approval required). F8 合議ワークフロー: stages with quorum (any/count/ratio/majority), finalGoUserId, onReject=fail_closed. Null policy = current 1-approver OR (AC W1). Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy + source layer (employee/org/none) + layers (employeeOverride/orgPolicy).",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee lookup" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "approvalWorkflow.patch",
    description:
      "Patch approval workflow policy after human approval (always_human). F8 合議ワークフロー: stages with quorum (any/count/ratio/majority), finalGoUserId, onReject=fail_closed. Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Admin cannot self-approve. When no workflow policy is set, current 1-approver OR remains (AC W1).",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string", description: "Optional employee ID for per-employee override" },
        clearOverride: { type: "boolean", description: "Set true to clear employee override and inherit org policy" },
        policyName: { type: "string", description: "Human-readable policy name" },
        stages: {
          type: "array",
          description: "Sequential approval stages (lanes)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              nameJa: { type: "string", description: "Stage display name in Japanese" },
              voterUserIds: { type: "array", items: { type: "string" }, description: "User IDs allowed to vote" },
              quorum: {
                type: "object",
                description: "Quorum rule: {type: 'any'} | {type: 'count', n: N} | {type: 'ratio', numerator, denominator} | {type: 'majority'}",
              },
              onReject: { type: "string", description: "fail_closed | count_as_vote. P0: fail_closed = 1 reject rejects entire instance" },
            },
            required: ["id", "nameJa", "voterUserIds", "quorum", "onReject"],
          },
        },
        finalGoUserId: { type: "string", description: "Optional user ID for final approval after all stages" },
        match: {
          type: "object",
          description: "Optional: which tools/purposes trigger this workflow",
          properties: {
            tools: { type: "array", items: { type: "string" } },
            purposes: { type: "array", items: { type: "string" } },
          },
        },
        jobId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "approvalWorkflow.inspect",
    description:
      "Inspect a workflow instance by approvalId (read-only, no approval required). F8: Returns instance status, current stage, ballot progress, finalGo status. Use to check workflow progress during approval.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string", description: "Approval request ID to inspect workflow for" },
      },
      required: ["approvalId"],
      additionalProperties: false,
    },
  },
  {
    name: "approvalWorkflow.remind",
    description:
      "Send a reminder card to the configured approval inbox after human approval (always_human). F8: targetApprovalId identifies the pending workflow. approvalId is reserved for reinvoking this reminder's own approved ticket. No private DM is sent.",
    inputSchema: {
      type: "object",
      properties: {
        targetApprovalId: { type: "string", description: "Pending workflow approval to remind" },
        approvalId: { type: "string", description: "Approved reminder request ID for reinvoke only" },
        jobId: { type: "string" },
      },
      required: ["targetApprovalId"],
      additionalProperties: false,
    },
  },
  {
    name: "orgs.create",
    description:
      "Create a new tenant (org + Auth owner + trial) after human approval (always_human). Platform super-admin only — normal tenant gb_adm_ is rejected (fail-closed). Reuses signup pipeline (createOrgWithOwner / provisionOrgForUser). Never returns or audits plaintext passwords. After success, issue AI employees via employees.issue in the new org.",
    inputSchema: {
      type: "object",
      properties: {
        orgName: { type: "string", description: "Organization display name" },
        ownerEmail: { type: "string", description: "Human owner email" },
        integrationMode: {
          type: "string",
          description: "managed | byo (default managed)",
        },
        trialDays: {
          type: "number",
          description: "Trial length in days (default 14, max 365)",
        },
        invite: {
          type: "boolean",
          description: "When true, omit ownerPassword — a random password is generated at fulfillment (never returned)",
        },
        ownerDisplayName: { type: "string" },
        ownerPassword: {
          type: "string",
          description: "Required for new Auth users when invite is false. Never stored in audit plaintext.",
        },
        jobId: { type: "string" },
        approvalId: {
          type: "string",
          description:
            "After human approval, re-invoke with this id to fulfill and read the result (pollHint: reinvoke_with_approvalId).",
        },
      },
      required: ["orgName", "ownerEmail"],
      additionalProperties: false,
    },
  },
  {
    name: "orgs.status",
    description:
      "Read org trial/subscription status by orgId (read-only, no approval). Platform super-admin only — fail-closed for normal tenant admins.",
    inputSchema: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Target organization UUID" },
      },
      required: ["orgId"],
      additionalProperties: false,
    },
  },
  {
    name: "orgs.patch",
    description:
      "Patch org metadata (currently: name only). Platform super-admin only — fail-closed for normal tenant admins. NOT always_human: the platform-ops actor (Super Admin) is the human deciding. Audit records previousName, newName, actorEmail. Use for cross-tenant rename operations (e.g. TOKYO307 setup).",
    inputSchema: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Target organization UUID" },
        name: { type: "string", description: "New organization display name (trim, non-empty, max 200 chars)" },
      },
      required: ["orgId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "orgs.issueAdminCredential",
    description:
      "Mint a tenant-scoped gb_adm_ admin MCP bearer for a target org after human approval (always_human). Platform super-admin only — normal tenant gb_adm_ is rejected (fail-closed). Issued credential scopes to target orgId, not the caller ops org. Returns oneTimeSecret once after approval (same pattern as employees.issue). Never logs or audits the raw secret.",
    inputSchema: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Target organization UUID to mint gb_adm_ for" },
        jobId: { type: "string" },
        approvalId: {
          type: "string",
          description:
            "After human approval, re-invoke with this id to fulfill and read the result (pollHint: reinvoke_with_approvalId).",
        },
      },
      required: ["orgId"],
      additionalProperties: false,
    },
  },
  {
    name: "approvals.proxyResolve",
    description:
      "Resolve a pending approval ticket for a tenant org on their behalf (platform ops proxy). Platform super-admin only — requires SUPER_ADMIN allowlist + optional PLATFORM_OPS_ORG_ID (fail-closed). Requires mandate (setup | support) for audit compliance. Audit records: targetOrgId, approvalId, mandate, note, actorEmail, actorUserId, decision, timestamp. Visible on tenant change log as platform proxy action (Japanese summary). Self-approval still denied (admin agent cannot approve its own request). After approve, same fulfill path as normal resolution (fulfillApprovedAdmin / fulfillApprovedInvoke). NOT wrapped in another always_human ticket — this tool IS the human decision for platform ops. Use during tenant setup代行 when their LINE/Telegram approval inbox is empty.",
    inputSchema: {
      type: "object",
      properties: {
        orgId: { type: "string", description: "Target tenant organization UUID" },
        approvalId: { type: "string", description: "Pending approval ticket UUID to resolve" },
        decision: {
          type: "string",
          enum: ["approved", "rejected"],
          description: "Resolution decision: approved | rejected",
        },
        mandate: {
          type: "string",
          enum: ["setup", "support"],
          description: "Mandate/名目 for audit: setup (セットアップ代行) | support (サポート対応)",
        },
        note: {
          type: "string",
          description: "Optional free-text note for audit (e.g., 'Space Tree初期設定のため')",
        },
        jobId: { type: "string", description: "Optional correlation job ID" },
      },
      required: ["orgId", "approvalId", "decision", "mandate"],
      additionalProperties: false,
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

const ADMIN_READ_ONLY_TOOLS = new Set<string>([
  "setup.slackStatus",
  "setup.connectInternalBase",
  "setup.lineApprovalStatus",
  "ingressHandoff.get",
  "schedulingPolicy.get",
  "replyPolicy.get",
  "mailPolicy.get",
  "internalAudienceRule.get",
  "stuckWatch.get",
  "stuckWatch.list",
  "stuckWatch.inspect",
  "stuckWatch.classify",
  "stuckWatch.retry",
  "stuckWatch.resolve",
  "approvalWorkflow.get",
  "approvalWorkflow.inspect",
  "orgs.status",
  "orgs.patch",
]);

function isAdminMutationTool(name: string): boolean {
  return isAdminMcpToolName(name) && !ADMIN_READ_ONLY_TOOLS.has(name);
}

function extractApprovalId(args: Record<string, unknown>): string {
  const raw = args.approvalId;
  return typeof raw === "string" ? raw.trim() : "";
}

async function handleAdminApprovalReinvoke(
  toolName: string,
  approvalId: string,
  cred: ResolvedAdminCredential
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}> {
  const approval = await getApprovalById(approvalId, cred.orgId);
  if (!approval) {
    return toolResult(
      { ok: false, code: "approval_not_found", message: "承認チケットが見つかりません" },
      true
    );
  }

  if (!(await canReadAdminApproval(approval, cred))) {
    return toolResult({ ok: false, code: "approval_requester_mismatch", message: "この資格情報では承認結果を取得できません" }, true);
  }
  const approvalTool = String(approval.metadata?.adminTool || approval.tool || "").trim();
  if (approvalTool && approvalTool !== toolName) {
    return toolResult(
      {
        ok: false,
        code: "approval_tool_mismatch",
        message: `approvalId は ${approvalTool} 用です（要求: ${toolName}）`,
      },
      true
    );
  }

  if (approval.status === "pending") {
    return toolResult(
      {
        ok: false,
        code: "needs_approval",
        needs_approval: true,
        approvalId: approval.id,
        statusToken: approval.statusToken,
        pollUrl: buildPollUrl(approval.id, approval.statusToken),
        pollPath: approval.pollPath,
        pollHint: "continue_polling",
        title: approval.title,
        summary: approval.summary,
        tool: approvalTool || toolName,
        always_human: true,
        auditClass: ADMIN_AUDIT_CLASS,
        auditAction: auditActionForAdminTool(toolName),
      },
      false
    );
  }

  if (approval.status === "rejected") {
    return toolResult(
      { ok: false, code: "approval_rejected", message: "承認が拒否されました" },
      true
    );
  }

  if (approval.status === "expired") {
    return toolResult(
      { ok: false, code: "approval_expired", message: "承認チケットの期限が切れました" },
      true
    );
  }

  if (approval.status === "revision_requested") {
    return toolResult(
      {
        ok: false,
        code: "revision_requested",
        message: "修正が要求されています",
        revisionNote: approval.revisionNote,
        parentApprovalId: approval.id,
      },
      true
    );
  }

  if (approval.status === "approved") {
    await fulfillApprovedAdmin(approval);
    const result = await readApprovedAdminResult(cred, approvalId);
    if (!result) {
      return toolResult(
        { ok: false, code: "fulfillment_failed", message: "承認後の履行に失敗しました" },
        true
      );
    }
    return toolResult(result, result.ok === false);
  }

  return toolResult(
    { ok: false, code: "approval_not_approved", message: "承認が完了していません" },
    true
  );
}

export function adminToolsAlwaysHuman(): boolean {
  return true;
}

async function runSlackStatusDiagnose(
  cred: ResolvedAdminCredential,
  channelId?: string | null
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const slackStatus = await diagnoseSlackStatus(cred.orgId);

  const normalizedChannelId = channelId?.trim() || null;
  let connectInternalBaseReadiness = null;
  if (normalizedChannelId) {
    connectInternalBaseReadiness = await diagnoseChannelInternalBaseReadiness(
      cred.orgId,
      normalizedChannelId
    );
  }

  const IC_GUIDANCE_JA =
    "ICはクライアントで下げられない（raise-only）。public は information_assets + assetRef が必要。フリーテキスト送信は confidential → 承認が正解。";

  const result = {
    ...slackStatus,
    connectInternalBaseReadiness,
    icGuidanceJa: normalizedChannelId ? IC_GUIDANCE_JA : undefined,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

async function runConnectInternalBaseDiagnose(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const channelId = typeof args.channelId === "string" ? args.channelId.trim() : null;

  if (!channelId) {
    return toolResult(
      {
        ok: false,
        code: "channel_id_required",
        message: "channelId が必要です",
        nextStepJa: "診断対象の Slack Connect チャネル ID（C で始まる ID）を channelId 引数に渡してください",
      },
      true
    );
  }

  const result = await diagnoseConnectInternalBase(cred.orgId, channelId);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: !result.ok,
  };
}

async function runLineApprovalStatusDiagnose(
  cred: ResolvedAdminCredential
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const result = await diagnoseLineApprovalStatus(cred.orgId);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

type IngressHandoffGetResult = {
  ok: boolean;
  policy: Awaited<ReturnType<typeof getEffectiveIngressHandoffPolicy>>["policy"];
  source: IngressHandoffPolicySource;
  layers: {
    employeeOverride: Awaited<ReturnType<typeof getEffectiveIngressHandoffPolicy>>["employeeOverride"];
    orgPolicy: Awaited<ReturnType<typeof getEffectiveIngressHandoffPolicy>>["orgPolicy"];
  };
  summaryJa: string;
  sourceJa: string;
  nextStepJa: string;
  hasHighRiskAutomation: boolean;
  highRiskConsentRecorded: boolean;
};

const SOURCE_JA: Record<IngressHandoffPolicySource, string> = {
  employee: "AI社員オーバーライド",
  org: "組織ポリシー",
  default: "デフォルト（便利設定）",
};

async function runIngressHandoffGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  if (employeeId) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
  }

  const effective = await getEffectiveIngressHandoffPolicy(cred.orgId, employeeId);
  const hasHighRisk = ingressPolicyHasHighRisk(effective.policy);
  const result: IngressHandoffGetResult = {
    ok: true,
    policy: effective.policy,
    source: effective.source,
    layers: {
      employeeOverride: effective.employeeOverride,
      orgPolicy: effective.orgPolicy,
    },
    summaryJa: summarizeIngressHandoffPolicyJa(effective.policy),
    sourceJa: SOURCE_JA[effective.source],
    nextStepJa: nextStepIngressHandoffJa(effective.policy),
    hasHighRiskAutomation: hasHighRisk,
    highRiskConsentRecorded: Boolean(effective.policy.highRiskConsentAt),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

type SchedulingPolicyGetResult = {
  ok: boolean;
  policy: Awaited<ReturnType<typeof getEffectiveSchedulingPolicy>>["policy"];
  source: SchedulingPolicySource;
  layers: {
    employeeOverride: Awaited<ReturnType<typeof getEffectiveSchedulingPolicy>>["employeeOverride"];
    orgPolicy: Awaited<ReturnType<typeof getEffectiveSchedulingPolicy>>["orgPolicy"];
  };
  summaryJa: string;
  sourceJa: string;
  nextStepJa: string;
  hasHighRiskAutomation: boolean;
  highRiskConsentRecorded: boolean;
};

const SCHEDULING_SOURCE_JA: Record<SchedulingPolicySource, string> = {
  employee: "AI社員オーバーライド",
  org: "組織ポリシー",
  default: "デフォルト（always_human）",
};

const REPLY_POLICY_SOURCE_JA: Record<ReplyPolicySource, string> = {
  employee: "AI社員オーバーライド",
  org: "組織ポリシー",
  default: "デフォルト（draft_only / 絵文字制限 / スレッド優先）",
};

const MAIL_POLICY_SOURCE_JA: Record<MailPolicySource, string> = {
  employee: "AI社員オーバーライド",
  org: "組織ポリシー",
  default: "デフォルト（外部宛 draft_only）",
};

async function runSchedulingPolicyGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  if (employeeId) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
  }

  const effective = await getEffectiveSchedulingPolicy(cred.orgId, employeeId);
  const hasHighRisk = schedulingPolicyHasHighRisk(effective.policy);
  const result: SchedulingPolicyGetResult = {
    ok: true,
    policy: effective.policy,
    source: effective.source,
    layers: {
      employeeOverride: effective.employeeOverride,
      orgPolicy: effective.orgPolicy,
    },
    summaryJa: summarizeSchedulingPolicyJa(effective.policy),
    sourceJa: SCHEDULING_SOURCE_JA[effective.source],
    nextStepJa: nextStepSchedulingPolicyJa(effective.policy),
    hasHighRiskAutomation: hasHighRisk,
    highRiskConsentRecorded: Boolean(effective.policy.highRiskConsentAt),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

type ReplyPolicyGetResult = {
  ok: boolean;
  policy: Awaited<ReturnType<typeof getEffectiveReplyPolicy>>["policy"];
  source: ReplyPolicySource;
  layers: {
    employeeOverride: Awaited<ReturnType<typeof getEffectiveReplyPolicy>>["employeeOverride"];
    orgPolicy: Awaited<ReturnType<typeof getEffectiveReplyPolicy>>["orgPolicy"];
  };
  summaryJa: string;
  sourceJa: string;
  nextStepJa: string;
  hasHighRiskAutoSend: boolean;
  highRiskConsentRecorded: boolean;
};

async function runReplyPolicyGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  if (employeeId) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
  }

  const effective = await getEffectiveReplyPolicy(cred.orgId, employeeId);
  const hasHighRisk = policyHasHighRiskAutoSend(effective.policy);
  const result: ReplyPolicyGetResult = {
    ok: true,
    policy: effective.policy,
    source: effective.source,
    layers: {
      employeeOverride: effective.employeeOverride,
      orgPolicy: effective.orgPolicy,
    },
    summaryJa: summarizeReplyPolicyJa(effective.policy),
    sourceJa: REPLY_POLICY_SOURCE_JA[effective.source],
    nextStepJa: nextStepReplyPolicyJa(effective.policy),
    hasHighRiskAutoSend: hasHighRisk,
    highRiskConsentRecorded: Boolean(effective.policy.highRiskConsentAt),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

type InternalAudienceRuleGetResult = {
  ok: boolean;
  rule: Awaited<ReturnType<typeof getOrgInternalAudienceRule>>;
  summaryJa: string;
  nextStepJa: string;
};

function summarizeInternalAudienceRuleJa(
  rule: Awaited<ReturnType<typeof getOrgInternalAudienceRule>>
): string {
  const parts: string[] = [];
  if (rule.emailDomains.length > 0) {
    parts.push(`メールドメイン: ${rule.emailDomains.join(", ")}`);
  }
  if (rule.slackTeamIds.length > 0) {
    parts.push(`Slack チーム: ${rule.slackTeamIds.join(", ")}`);
  }
  if (rule.autoSlackTeamInternal) {
    parts.push("自動Slackチーム内部判定: 有効");
  }
  if (parts.length === 0) {
    return "内部オーディエンスルール未設定（parties台帳のみで判定）";
  }
  return parts.join(" / ");
}

function nextStepInternalAudienceRuleJa(
  rule: Awaited<ReturnType<typeof getOrgInternalAudienceRule>>
): string {
  if (rule.slackTeamIds.length === 0 && !rule.autoSlackTeamInternal) {
    return "大規模チャネル（stablo規模）を使う場合は、slackTeamIds を設定し autoSlackTeamInternal=true にすると、自社Slackメンバーを自動で内部扱いにできます。例: #stablo_tokyo307 Connect チャネル。";
  }
  if (rule.autoSlackTeamInternal && rule.slackTeamIds.length > 0) {
    return "Slack チームルールが設定済みです。自社チームメンバーは内部扱い、Connect ゲストは fail-closed で外部扱いになります。";
  }
  return "parties.upsert で個別パーティを登録するか、internalAudienceRule.patch でドメイン/チームルールを設定してください。";
}

type MailPolicyGetResult = {
  ok: boolean;
  policy: Awaited<ReturnType<typeof getEffectiveMailPolicy>>["policy"];
  source: MailPolicySource;
  layers: {
    employeeOverride: Awaited<ReturnType<typeof getEffectiveMailPolicy>>["employeeOverride"];
    orgPolicy: Awaited<ReturnType<typeof getEffectiveMailPolicy>>["orgPolicy"];
  };
  summaryJa: string;
  sourceJa: string;
  nextStepJa: string;
  hasHighRiskAutoSend: boolean;
  highRiskConsentRecorded: boolean;
};

async function runMailPolicyGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  if (employeeId) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
  }

  const effective = await getEffectiveMailPolicy(cred.orgId, employeeId);
  const hasHighRisk = mailPolicyHasHighRiskAutoSend(effective.policy);
  const result: MailPolicyGetResult = {
    ok: true,
    policy: effective.policy,
    source: effective.source,
    layers: {
      employeeOverride: effective.employeeOverride,
      orgPolicy: effective.orgPolicy,
    },
    summaryJa: summarizeMailPolicyJa(effective.policy),
    sourceJa: MAIL_POLICY_SOURCE_JA[effective.source],
    nextStepJa: nextStepMailPolicyJa(effective.policy),
    hasHighRiskAutoSend: hasHighRisk,
    highRiskConsentRecorded: Boolean(effective.policy.highRiskConsentAt),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

async function runInternalAudienceRuleGet(
  cred: ResolvedAdminCredential
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const rule = await getOrgInternalAudienceRule(cred.orgId);
  const result: InternalAudienceRuleGetResult = {
    ok: true,
    rule,
    summaryJa: summarizeInternalAudienceRuleJa(rule),
    nextStepJa: nextStepInternalAudienceRuleJa(rule),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function summarizeStuckWatchPolicyJa(
  policy: Awaited<ReturnType<typeof getOrgStuckWatchPolicy>>
): string {
  const parts = [
    policy.enabled ? "有効" : "無効",
    `W1=${policy.mentionUnansweredMinutes}分`,
    `W2=${policy.approvedUnfulfilledMinutes}分`,
    `自動リトライ最大${policy.maxAutoRetries}回`,
    `バックオフ${policy.retryBackoffSeconds}秒`,
    `autoRetry=${policy.autoRetryFaultClasses.join(",")}`,
  ];
  if (policy.inferInternalAudienceFromLedger) {
    parts.push("台帳から内部audience推論あり");
  }
  return `F7 Stuck Watch: ${parts.join(" · ")}`;
}

async function runStuckWatchGet(
  cred: ResolvedAdminCredential
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const policy = await getOrgStuckWatchPolicy(cred.orgId);
  const defaults = defaultStuckWatchPolicy();
  const result = {
    ok: true,
    policy,
    defaults,
    summaryJa: summarizeStuckWatchPolicyJa(policy),
    nextStepJa:
      "不当停止は stuckWatch.list で確認し、ops_fault は stuckWatch.retry、正当ゲートは resolve のみ。W1/W2 閾値は stuckWatch.patch で調整できます。",
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

const APPROVAL_WORKFLOW_SOURCE_JA: Record<ApprovalWorkflowPolicySource, string> = {
  employee: "AI社員オーバーライド",
  org: "組織ポリシー",
  none: "未設定（現行1人承認）",
};

type ApprovalWorkflowGetResult = {
  ok: boolean;
  policy: Awaited<ReturnType<typeof getEffectiveApprovalWorkflowPolicy>>["policy"];
  source: ApprovalWorkflowPolicySource;
  layers: {
    employeeOverride: Awaited<ReturnType<typeof getEffectiveApprovalWorkflowPolicy>>["employeeOverride"];
    orgPolicy: Awaited<ReturnType<typeof getEffectiveApprovalWorkflowPolicy>>["orgPolicy"];
  };
  summaryJa: string;
  sourceJa: string;
  nextStepJa: string;
};

async function runApprovalWorkflowGet(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;

  if (employeeId) {
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
  }

  const effective = await getEffectiveApprovalWorkflowPolicy(cred.orgId, employeeId);
  const result: ApprovalWorkflowGetResult = {
    ok: true,
    policy: effective.policy,
    source: effective.source,
    layers: {
      employeeOverride: effective.employeeOverride,
      orgPolicy: effective.orgPolicy,
    },
    summaryJa: summarizeApprovalWorkflowPolicyJa(effective.policy),
    sourceJa: APPROVAL_WORKFLOW_SOURCE_JA[effective.source],
    nextStepJa: nextStepApprovalWorkflowJa(effective.policy),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

async function runApprovalWorkflowInspect(
  cred: ResolvedAdminCredential,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const approvalId = typeof args.approvalId === "string" ? args.approvalId.trim() : "";
  if (!approvalId) {
    return toolResult(
      { ok: false, code: "approval_id_required", message: "approvalIdが必要です" },
      true
    );
  }

  const approval = await getApprovalById(approvalId, cred.orgId);
  if (!approval) {
    return toolResult(
      { ok: false, code: "approval_not_found", message: "承認チケットが見つかりません" },
      true
    );
  }

  const progress = await getApprovalWorkflowProgress(approvalId);
  if (!progress) {
    return toolResult({
      ok: true,
      hasWorkflow: false,
      approval: {
        id: approval.id,
        status: approval.status,
        title: approval.title,
        tool: approval.tool,
      },
      summaryJa: "このチケットにはワークフローが設定されていません（現行1人承認）",
    });
  }

  const result = {
    ok: true,
    hasWorkflow: true,
    approval: {
      id: approval.id,
      status: approval.status,
      title: approval.title,
      tool: approval.tool,
    },
    workflow: {
      instanceId: progress.instanceId,
      status: progress.status,
      currentStageIndex: progress.currentStageIndex,
      currentStage: progress.currentStage,
      stages: progress.stages,
      finalGoPending: progress.finalGoPending,
      finalGoUserId: progress.finalGoUserId,
      finalGoVoted: progress.finalGoVoted,
    },
    summaryJa: progress.finalGoPending
      ? `ワークフロー: 最終Go待ち（ステージ完了）`
      : progress.currentStage
        ? `ワークフロー: ${progress.currentStage.nameJa} (${progress.currentStage.approved}/${progress.currentStage.quorumDisplay})`
        : `ワークフロー: ${progress.status}`,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
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

  if (name.startsWith("orgs.") || name === "approvals.proxyResolve") {
    const gate = await assertPlatformOpsFromAdminCred(cred);
    if (!gate.allowed) return toolResult({ ok: false, code: gate.code, message: gate.message }, true);
  }
  const approvalId = extractApprovalId(args);
  if (approvalId && name !== "approvals.proxyResolve" && isAdminMutationTool(name)) {
    return handleAdminApprovalReinvoke(name, approvalId, cred);
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

  if (name === "orgs.create" || name === "orgs.status" || name === "orgs.patch" || name === "orgs.issueAdminCredential") {
    const gate = await assertPlatformOpsFromAdminCred(cred);
    if (!gate.allowed) {
      return toolResult(
        { ok: false, code: gate.code, message: gate.message },
        true
      );
    }
    if (name === "orgs.status") {
      const orgId = String(args.orgId || "").trim();
      const result = await platformOrgStatus(orgId);
      const isError = result.ok === false;
      return toolResult(result, isError);
    }
    if (name === "orgs.patch") {
      const parsed = validateOrgPatchInput(args);
      if (!parsed.ok) {
        return toolResult(
          { ok: false, code: parsed.code, message: parsed.message },
          true
        );
      }
      try {
        const result = await platformPatchOrg(parsed.value, gate.actor);
        return toolResult({ ok: true, ...result }, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "patch_failed";
        return toolResult(
          { ok: false, code: "patch_failed", message },
          true
        );
      }
    }
  }

  if (name === "approvals.proxyResolve") {
    const gate = await assertPlatformOpsFromAdminCred(cred);
    if (!gate.allowed) {
      return toolResult(
        { ok: false, code: gate.code, message: gate.message },
        true
      );
    }

    const targetOrgId = String(args.orgId || "").trim();
    const approvalId = String(args.approvalId || "").trim();
    const decision = String(args.decision || "").trim();
    const mandate = String(args.mandate || "").trim();
    const note = String(args.note || "").trim();

    if (!targetOrgId) {
      return toolResult(
        { ok: false, code: "org_id_required", message: "orgId が必要です" },
        true
      );
    }
    if (!approvalId) {
      return toolResult(
        { ok: false, code: "approval_id_required", message: "approvalId が必要です" },
        true
      );
    }
    if (!["approved", "rejected"].includes(decision)) {
      return toolResult(
        { ok: false, code: "invalid_decision", message: "decision は approved | rejected のいずれかを指定してください" },
        true
      );
    }
    if (!PROXY_APPROVAL_MANDATES.includes(mandate as ProxyApprovalMandate)) {
      return toolResult(
        { ok: false, code: "invalid_mandate", message: `mandate は ${PROXY_APPROVAL_MANDATES.join(" | ")} のいずれかを指定してください` },
        true
      );
    }

    const result = await proxyResolveApproval({
      resolver: { actorId: cred.actorId, grokBotAgentId: cred.grokBotAgentId },
      targetOrgId,
      approvalId,
      decision: decision as "approved" | "rejected",
      mandate: mandate as ProxyApprovalMandate,
      note: note || undefined,
      actor: {
        email: gate.actor.email,
        userId: gate.actor.userId || "",
      },
    });

    if (!result.ok) {
      return toolResult(
        { ok: false, code: result.code, message: result.error },
        true
      );
    }

    return toolResult({
      ok: true,
      decision,
      mandate,
      approvalId: result.approval?.id,
      status: result.approval?.status,
      resolvedBy: result.approval?.resolvedBy,
      resolvedAt: result.approval?.resolvedAt,
      tool: result.approval?.tool,
      jobId: result.approval?.jobId,
      sideEffectsRan: Boolean(result.sideEffects),
      summaryJa: `${decision === "approved" ? "承認" : "却下"}しました（プラットフォーム代行・${mandate}）`,
    });
  }

  if (name === "setup.slackStatus") {
    const channelId = typeof args.channelId === "string" ? args.channelId.trim() : null;
    return runSlackStatusDiagnose(cred, channelId);
  }

  if (name === "setup.connectInternalBase") {
    return runConnectInternalBaseDiagnose(cred, args);
  }

  if (name === "setup.lineApprovalStatus") {
    return runLineApprovalStatusDiagnose(cred);
  }

  if (name === "setup.slackAdapter.setBotToken") {
    const enabled = args.enabled !== false;
    const botToken = String(args.botToken || "").trim();
    if (enabled && !botToken) {
      return toolResult(
        {
          ok: false,
          code: "slack_adapter_token_required",
          message: `有効化するには Bot User OAuth Token (xoxb-...) が必要です。ダッシュボード「${DASHBOARD_BOT_TOKEN_PATH_JA}」と同じ値です（「承認を受け取る」のSlackではありません）。`,
        },
        true
      );
    }
    if (botToken && !botToken.startsWith("xoxb-")) {
      return toolResult(
        {
          ok: false,
          code: "invalid_bot_token_format",
          message:
            "Bot User OAuth Token は xoxb- で始まる必要があります。User Token (xoxp-) や承認インボックス用トークンはここでは使えません。",
        },
        true
      );
    }
  }

  if (name === "setup.lineApproval.upsert") {
    const enabled = args.enabled !== false;
    const destinationId = String(args.destinationId || "").trim();
    const channelAccessToken = String(args.channelAccessToken || "").trim();
    const channelSecret = String(args.channelSecret || "").trim();
    const channelId = String(args.channelId || "").trim();
    const channels = await listNotificationChannels(cred.orgId);
    const existing = channelId
      ? channels.find((channel) => channel.id === channelId && channel.provider === "line")
      : undefined;
    if (channelId && !existing) {
      return toolResult(
        { ok: false, code: "line_channel_not_found", message: "指定の LINE 承認チャネルが見つかりません" },
        true
      );
    }
    if (enabled && !destinationId) {
      return toolResult(
        { ok: false, code: "destination_required", message: "有効化するには destinationId が必要です" },
        true
      );
    }
    const hasExistingCredentials = Boolean(existing?.hasCredentials);
    if (enabled && !channelAccessToken && !hasExistingCredentials) {
      return toolResult(
        {
          ok: false,
          code: "line_credentials_incomplete",
          message: "有効化するには channelAccessToken / channelSecret が必要です（既存 secret がある場合は省略可）",
        },
        true
      );
    }
    if (enabled && !channelSecret && !hasExistingCredentials) {
      return toolResult(
        {
          ok: false,
          code: "line_credentials_incomplete",
          message: "有効化するには channelAccessToken / channelSecret が必要です（既存 secret がある場合は省略可）",
        },
        true
      );
    }
  }

  if (name === "setup.lineApproval.setEmployeeInbox") {
    const employeeId = String(args.employeeId || "").trim();
    if (!employeeId) {
      return toolResult(
        { ok: false, code: "employee_id_required", message: "employeeId が必要です" },
        true
      );
    }
    const employee = await getEmployee(employeeId, cred.orgId);
    if (!employee) {
      return toolResult(
        { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
        true
      );
    }
    if (args.approvalChannelId !== undefined && args.approvalChannelId !== null) {
      const lineIds = (await listNotificationChannels(cred.orgId))
        .filter((channel) => channel.provider === "line")
        .map((channel) => channel.id);
      const parsed = parseApprovalChannelId(args.approvalChannelId, lineIds);
      if (!parsed.ok) {
        return toolResult(
          {
            ok: false,
            code: "line_approval_channel_not_found",
            message: "approvalChannelId は同一 org の LINE 承認チャネルである必要があります",
          },
          true
        );
      }
    }
  }

  if (name === "setup.lineApproval.demoteTelegram") {
    const mode = String(args.mode || "").trim();
    if (mode !== "disable" && mode !== "clearDefault") {
      return toolResult(
        { ok: false, code: "invalid_mode", message: "mode は disable または clearDefault です" },
        true
      );
    }
    const channelId = String(args.channelId || "").trim();
    const channels = await listNotificationChannels(cred.orgId);
    if (channelId) {
      const target = channels.find(
        (channel) => channel.id === channelId && channel.provider === "telegram"
      );
      if (!target) {
        return toolResult(
          { ok: false, code: "telegram_channel_not_found", message: "指定の Telegram 承認チャネルが見つかりません" },
          true
        );
      }
    }
    if (mode === "clearDefault") {
      const lineDefault = channels.find(
        (channel) => channel.provider === "line" && channel.enabled
      );
      if (!lineDefault) {
        return toolResult(
          {
            ok: false,
            code: "line_default_required",
            message: "clearDefault には有効な既定 LINE 承認チャネルが必要です",
          },
          true
        );
      }
    }
  }

  if (name === "ingressHandoff.get") {
    return runIngressHandoffGet(cred, args);
  }

  if (name === "ingressHandoff.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;

    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
    }

    if (clearOverride) {
      if (!employeeId) {
        return toolResult(
          { ok: false, code: "clear_requires_employee", message: "オーバーライドのクリアはemployeeIdが必要です" },
          true
        );
      }
    } else {
      if (!Array.isArray(args.rules) || args.rules.length === 0) {
        return toolResult(
          { ok: false, code: "rules_required", message: "rulesが必要です（clearOverride=true以外）" },
          true
        );
      }

      const existingPolicy = await getEffectiveIngressHandoffPolicy(cred.orgId, employeeId);
      const existingConsent = existingPolicy.policy.highRiskConsentAt
        ? { at: existingPolicy.policy.highRiskConsentAt, by: existingPolicy.policy.highRiskConsentBy || "unknown" }
        : null;

      const validationResult = validateIngressHandoffPolicy(
        {
          policyName: args.policyName,
          rules: args.rules,
          highRiskConsentAt: args.highRiskConsentAt,
          highRiskConsentBy: args.highRiskConsentBy,
        },
        {
          requireHighRiskConsent: true,
          existingConsent,
        }
      );
      if (!validationResult.ok) {
        const hasHighRiskError = validationResult.errors.some(
          (e) => e.code === "high_risk_consent_required"
        );
        return toolResult(
          {
            ok: false,
            code: hasHighRiskError ? "high_risk_consent_required" : "validation_failed",
            message: hasHighRiskError
              ? "高リスク設定（添付=ファイル + Sealith=オフ + 外部/機密分類）にはテナント承諾が必要です。highRiskConsentAt/By を設定してください。"
              : "ルールの検証に失敗しました",
            errors: validationResult.errors,
            warningJa: hasHighRiskError
              ? "【高リスク警告】外部/機密チャネルにファイル本体をSealithなしで渡す設定は silent enable 禁止。承諾 + settings on audit (F4/F5)。"
              : undefined,
          },
          true
        );
      }
    }
  }

  if (name === "schedulingPolicy.get") {
    return runSchedulingPolicyGet(cred, args);
  }

  if (name === "replyPolicy.get") {
    return runReplyPolicyGet(cred, args);
  }

  if (name === "mailPolicy.get") {
    return runMailPolicyGet(cred, args);
  }

  if (name === "internalAudienceRule.get") {
    return runInternalAudienceRuleGet(cred);
  }

  if (name === "stuckWatch.get") {
    return runStuckWatchGet(cred);
  }

  if (name === "stuckWatch.list") {
    const result = await runStuckWatchList(cred.orgId, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: !result.ok,
    };
  }

  if (name === "stuckWatch.inspect") {
    const result = await runStuckWatchInspect(cred.orgId, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: !result.ok,
    };
  }

  if (name === "stuckWatch.classify") {
    const result = await runStuckWatchClassify(cred.orgId, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: !result.ok,
    };
  }

  if (name === "stuckWatch.retry") {
    const result = await runStuckWatchRetry(cred.orgId, args, cred.actorId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: !result.ok,
    };
  }

  if (name === "stuckWatch.resolve") {
    const result = await runStuckWatchResolve(cred.orgId, args, cred.actorId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: !result.ok,
    };
  }

  if (name === "approvalWorkflow.get") {
    return runApprovalWorkflowGet(cred, args);
  }

  if (name === "approvalWorkflow.inspect") {
    return runApprovalWorkflowInspect(cred, args);
  }

  if (name === "approvalWorkflow.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;

    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
    }

    if (clearOverride) {
      if (!employeeId) {
        return toolResult(
          { ok: false, code: "clear_requires_employee", message: "オーバーライドのクリアはemployeeIdが必要です" },
          true
        );
      }
    } else {
      if (!Array.isArray(args.stages) || args.stages.length === 0) {
        return toolResult(
          { ok: false, code: "stages_required", message: "stagesが必要です（clearOverride=true以外）" },
          true
        );
      }

      const validationResult = validateApprovalWorkflowPolicy({
        policyName: args.policyName,
        stages: args.stages,
        finalGoUserId: args.finalGoUserId,
        match: args.match,
      });

      if (!validationResult.ok) {
        return toolResult(
          {
            ok: false,
            code: "validation_failed",
            message: "ワークフローポリシーの検証に失敗しました",
            errors: validationResult.errors,
          },
          true
        );
      }
    }
  }

  if (name === "approvalWorkflow.remind") {
    const targetId = typeof args.targetApprovalId === "string" ? args.targetApprovalId.trim() : "";
    if (!targetId) {
      return toolResult(
        { ok: false, code: "target_approval_id_required", message: "targetApprovalIdが必要です" },
        true
      );
    }
    const target = await getApprovalById(targetId, cred.orgId);
    if (!target || target.status !== "pending") return toolResult({ ok: false, code: "target_approval_not_pending" }, true);
  }

  if (name === "replyPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;

    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
    }

    if (clearOverride) {
      if (!employeeId) {
        return toolResult(
          { ok: false, code: "clear_requires_employee", message: "オーバーライドのクリアはemployeeIdが必要です" },
          true
        );
      }
    } else {
      if (!Array.isArray(args.rules) || args.rules.length === 0) {
        return toolResult(
          { ok: false, code: "rules_required", message: "rulesが必要です（clearOverride=true以外）" },
          true
        );
      }

      const existingPolicy = await getEffectiveReplyPolicy(cred.orgId, employeeId);
      const existingConsent = existingPolicy.policy.highRiskConsentAt
        ? { at: existingPolicy.policy.highRiskConsentAt, by: existingPolicy.policy.highRiskConsentBy || "unknown" }
        : null;

      const validationResult = validateReplyPolicy(
        {
          policyName: args.policyName,
          rules: args.rules,
          highRiskConsentAt: args.highRiskConsentAt,
          highRiskConsentBy: args.highRiskConsentBy,
        },
        {
          requireHighRiskConsent: true,
          existingConsent,
        }
      );

      if (!validationResult.ok) {
        const hasHighRiskError = validationResult.errors.some(
          (e) => e.code === "high_risk_consent_required"
        );
        return toolResult(
          {
            ok: false,
            code: hasHighRiskError ? "high_risk_consent_required" : "validation_failed",
            message: hasHighRiskError
              ? "営業時間外の自動送信にはテナント承諾が必要です。highRiskConsentAt/By を設定してください。"
              : "ルールの検証に失敗しました",
            errors: validationResult.errors,
            warningJa: hasHighRiskError
              ? "【高リスク警告】営業時間外の自動送信は silent enable 禁止。承諾 + settings on audit。"
              : undefined,
          },
          true
        );
      }
    }
  }

  if (name === "mailPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;

    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
    }

    if (clearOverride) {
      if (!employeeId) {
        return toolResult(
          { ok: false, code: "clear_requires_employee", message: "オーバーライドのクリアはemployeeIdが必要です" },
          true
        );
      }
    } else {
      if (!Array.isArray(args.rules) || args.rules.length === 0) {
        return toolResult(
          { ok: false, code: "rules_required", message: "rulesが必要です（clearOverride=true以外）" },
          true
        );
      }

      const existingPolicy = await getEffectiveMailPolicy(cred.orgId, employeeId);
      const existingConsent = existingPolicy.policy.highRiskConsentAt
        ? { at: existingPolicy.policy.highRiskConsentAt, by: existingPolicy.policy.highRiskConsentBy || "unknown" }
        : null;

      const validationResult = validateMailPolicy(
        {
          policyName: args.policyName,
          rules: args.rules,
          highRiskConsentAt: args.highRiskConsentAt,
          highRiskConsentBy: args.highRiskConsentBy,
        },
        {
          requireHighRiskConsent: true,
          existingConsent,
        }
      );

      if (!validationResult.ok) {
        const hasHighRiskError = validationResult.errors.some(
          (e) => e.code === "high_risk_consent_required"
        );
        return toolResult(
          {
            ok: false,
            code: hasHighRiskError ? "high_risk_consent_required" : "validation_failed",
            message: hasHighRiskError
              ? "sendMode auto にはテナント承諾が必要です。highRiskConsentAt/By を設定してください。"
              : "ルールの検証に失敗しました",
            errors: validationResult.errors,
            warningJa: hasHighRiskError
              ? "【高リスク警告】外部宛自動送信は silent enable 禁止。承諾 + settings on audit。"
              : undefined,
          },
          true
        );
      }
    }
  }

  if (name === "schedulingPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;

    if (employeeId) {
      const employee = await getEmployee(employeeId, cred.orgId);
      if (!employee) {
        return toolResult(
          { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" },
          true
        );
      }
    }

    if (clearOverride) {
      if (!employeeId) {
        return toolResult(
          { ok: false, code: "clear_requires_employee", message: "オーバーライドのクリアはemployeeIdが必要です" },
          true
        );
      }
    } else {
      if (!Array.isArray(args.rules) || args.rules.length === 0) {
        return toolResult(
          { ok: false, code: "rules_required", message: "rulesが必要です（clearOverride=true以外）" },
          true
        );
      }

      const existingPolicy = await getEffectiveSchedulingPolicy(cred.orgId, employeeId);
      const existingConsent = existingPolicy.policy.highRiskConsentAt
        ? { at: existingPolicy.policy.highRiskConsentAt, by: existingPolicy.policy.highRiskConsentBy || "unknown" }
        : null;

      const validationResult = validateSchedulingPolicy(
        {
          policyName: args.policyName,
          rules: args.rules,
          regionDictionary: args.regionDictionary,
          highRiskConsentAt: args.highRiskConsentAt,
          highRiskConsentBy: args.highRiskConsentBy,
        },
        {
          requireHighRiskConsent: true,
          existingConsent,
        }
      );

      if (!validationResult.ok) {
        const hasHighRiskError = validationResult.errors.some(
          (e) => e.code === "high_risk_consent_required"
        );
        return toolResult(
          {
            ok: false,
            code: hasHighRiskError ? "high_risk_consent_required" : "validation_failed",
            message: hasHighRiskError
              ? "高リスク自動化レベルにはテナント承諾が必要です。highRiskConsentAt/By を設定してください。"
              : "ルールの検証に失敗しました",
            errors: validationResult.errors,
            warningJa: hasHighRiskError
              ? "【高リスク警告】full_auto confirm / external 自動 / ポリシーなし自動は silent enable 禁止。承諾 + settings on audit。"
              : undefined,
          },
          true
        );
      }
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
  } else if (name === "ingressHandoff.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;
    const rulesCount = Array.isArray(args.rules) ? args.rules.length : 0;
    const hasHighRiskConsent = Boolean(args.highRiskConsentAt);
    const rulesArray = Array.isArray(args.rules) ? args.rules : [];
    const hasHighRiskConfig = ingressPolicyHasHighRisk({ rules: rulesArray as Parameters<typeof ingressPolicyHasHighRisk>[0]["rules"] });
    if (clearOverride && employeeId) {
      summary = `AI社員の受信の渡し方オーバーライドをクリアして組織ポリシーを継承します`;
    } else if (employeeId) {
      summary = `AI社員ごとの受信の渡し方オーバーライドを設定します（${rulesCount}ルール）`;
    } else {
      const consentNote = hasHighRiskConsent && hasHighRiskConfig ? "・高リスク承諾あり" : "";
      summary = `組織の受信の渡し方ポリシーの更新を人が確認します（${rulesCount}ルール${consentNote}）`;
    }
  } else if (name === "schedulingPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;
    const rulesCount = Array.isArray(args.rules) ? args.rules.length : 0;
    const hasHighRiskConsent = Boolean(args.highRiskConsentAt);
    if (clearOverride && employeeId) {
      summary = `AI社員のスケジューリングポリシーオーバーライドをクリアして組織ポリシーを継承します`;
    } else if (employeeId) {
      summary = `AI社員ごとのスケジューリングポリシーオーバーライドを設定します（${rulesCount}ルール）`;
    } else {
      const consentNote = hasHighRiskConsent ? "・高リスク承諾あり" : "";
      summary = `組織のスケジューリングポリシーの更新を人が確認します（${rulesCount}ルール${consentNote}）`;
    }
  } else if (name === "replyPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;
    const rulesCount = Array.isArray(args.rules) ? args.rules.length : 0;
    const hasHighRiskConsent = Boolean(args.highRiskConsentAt);
    if (clearOverride && employeeId) {
      summary = `AI社員の返信ポリシーオーバーライドをクリアして組織ポリシーを継承します`;
    } else if (employeeId) {
      summary = `AI社員ごとの返信ポリシーオーバーライドを設定します（${rulesCount}ルール）`;
    } else {
      const consentNote = hasHighRiskConsent ? "・高リスク承諾あり" : "";
      summary = `組織の返信ポリシーの更新を人が確認します（${rulesCount}ルール${consentNote}）`;
    }
  } else if (name === "mailPolicy.patch") {
    const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
      ? args.employeeId.trim()
      : null;
    const clearOverride = args.clearOverride === true;
    const rulesCount = Array.isArray(args.rules) ? args.rules.length : 0;
    const hasHighRiskConsent = Boolean(args.highRiskConsentAt);
    if (clearOverride && employeeId) {
      summary = `AI社員のメールポリシーオーバーライドをクリアして組織ポリシーを継承します`;
    } else if (employeeId) {
      summary = `AI社員ごとのメールポリシーオーバーライドを設定します（${rulesCount}ルール）`;
    } else {
      const consentNote = hasHighRiskConsent ? "・高リスク承諾あり" : "";
      summary = `組織のメールポリシーの更新を人が確認します（${rulesCount}ルール${consentNote}）`;
    }
  } else if (name === "internalAudienceRule.patch") {
    const emailDomains = Array.isArray(args.emailDomains) ? args.emailDomains.length : 0;
    const slackTeamIds = Array.isArray(args.slackTeamIds) ? args.slackTeamIds.length : 0;
    const autoSlackTeamInternal = args.autoSlackTeamInternal === true;
    const parts: string[] = [];
    if (emailDomains > 0) parts.push(`${emailDomains}ドメイン`);
    if (slackTeamIds > 0) parts.push(`${slackTeamIds}チーム`);
    if (autoSlackTeamInternal) parts.push("自動内部判定あり");
    summary = `内部オーディエンスルールの更新を人が確認します（${parts.join("・") || "設定なし"}）`;
  } else if (name === "stuckWatch.patch") {
    const enabled = args.enabled === false ? "無効化" : args.enabled === true ? "有効化" : null;
    const parts: string[] = [];
    if (enabled) parts.push(enabled);
    if (args.approvedUnfulfilledMinutes != null) {
      parts.push(`W2=${args.approvedUnfulfilledMinutes}分`);
    }
    if (args.maxAutoRetries != null) {
      parts.push(`maxRetry=${args.maxAutoRetries}`);
    }
    summary = `Stuck Watch ポリシーの更新を人が確認します（${parts.join("・") || "設定変更"}）`;
  } else if (name === "setup.slackAdapter.setBotToken") {
    const enabled = args.enabled !== false;
    const botToken = String(args.botToken || "").trim();
    const label = String(args.label || "").trim();
    queuedArgs = {
      enabled,
      label: label || null,
      botTokenPresent: Boolean(botToken),
      ...(botToken
        ? { botTokenCiphertext: encryptNotificationSecrets({ botToken }) }
        : {}),
      jobId: args.jobId,
    };
    summary = enabled
      ? `Slack会話投稿アダプタの Bot token 登録を人が確認します（ダッシュボード「${DASHBOARD_BOT_TOKEN_PATH_JA}」。「承認を受け取る」ではありません）`
      : `Slack会話投稿アダプタを無効化します（「承認を受け取る」のSlackとは別）`;
  } else if (name === "setup.lineApproval.upsert") {
    const enabled = args.enabled !== false;
    const destinationId = String(args.destinationId || "").trim();
    const channelAccessToken = String(args.channelAccessToken || "").trim();
    const channelSecret = String(args.channelSecret || "").trim();
    const label = String(args.label || "").trim();
    const allowedUserIds = Array.isArray(args.allowedUserIds)
      ? args.allowedUserIds.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 100)
      : [];
    const secrets: Record<string, string> = {};
    if (channelAccessToken) secrets.channelAccessToken = channelAccessToken;
    if (channelSecret) secrets.channelSecret = channelSecret;
    queuedArgs = {
      enabled,
      destinationId,
      allowedUserIds,
      label: label || null,
      isDefault: args.isDefault === true,
      channelId: String(args.channelId || "").trim() || null,
      channelAccessTokenPresent: Boolean(channelAccessToken),
      channelSecretPresent: Boolean(channelSecret),
      ...(Object.keys(secrets).length > 0
        ? { secretsCiphertext: encryptNotificationSecrets(secrets) }
        : {}),
      jobId: args.jobId,
    };
    summary = enabled
      ? `承認用 LINE チャネル登録を人が確認します（destinationId: ${destinationId.slice(0, 4)}…）`
      : "承認用 LINE チャネルを無効化します";
  } else if (name === "setup.lineApproval.setEmployeeInbox") {
    const employeeId = String(args.employeeId || "").trim();
    const approvalChannelId =
      args.approvalChannelId === undefined || args.approvalChannelId === null
        ? null
        : String(args.approvalChannelId).trim() || null;
    queuedArgs = {
      employeeId,
      approvalChannelId,
      jobId: args.jobId,
    };
    summary = approvalChannelId
      ? `AI社員 ${employeeId} の承認インボックスを LINE チャネルへ割り当てることを人が確認します`
      : `AI社員 ${employeeId} の承認インボックスを組織既定へ戻すことを人が確認します`;
  } else if (name === "setup.lineApproval.demoteTelegram") {
    const mode = args.mode === "clearDefault" ? "clearDefault" : "disable";
    queuedArgs = {
      mode,
      channelId: String(args.channelId || "").trim() || null,
      jobId: args.jobId,
    };
    summary =
      mode === "clearDefault"
        ? "Telegram 既定承認チャネルを無効化して LINE 単独送信にすることを人が確認します"
        : "Telegram 承認チャネルを無効化することを人が確認します";
  } else if (name === "orgs.create") {
    const parsed = validateOrgCreateInput(args);
    if (!parsed.ok) {
      return toolResult(
        { ok: false, code: parsed.code, message: parsed.message },
        true
      );
    }
    const gate = await assertPlatformOpsFromAdminCred(cred);
    if (!gate.allowed) {
      return toolResult(
        { ok: false, code: gate.code, message: gate.message },
        true
      );
    }
    queuedArgs = {
      ...queueOrgCreateArgs(
        parsed.value,
        typeof args.jobId === "string" ? args.jobId : undefined
      ),
      platformActorEmail: gate.actor.email,
      platformActorUserId: gate.actor.userId,
      platformActorOrgId: gate.actor.orgId,
    };
    summary = `テナント作成を人が確認します（${parsed.value.orgName} · ${parsed.value.ownerEmail}）`;
  } else if (name === "orgs.issueAdminCredential") {
    const parsed = validateOrgIssueAdminCredentialInput(args);
    if (!parsed.ok) {
      return toolResult(
        { ok: false, code: parsed.code, message: parsed.message },
        true
      );
    }
    const gate = await assertPlatformOpsFromAdminCred(cred);
    if (!gate.allowed) {
      return toolResult(
        { ok: false, code: gate.code, message: gate.message },
        true
      );
    }
    queuedArgs = queueOrgIssueAdminCredentialArgs(parsed.value, gate.actor);
    summary = `管理MCP認証（gb_adm_）発行を人が確認します（対象 org: ${parsed.value.targetOrgId.slice(0, 8)}…）`;
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
  if (!approval || approval.status !== "approved" || !(await canReadAdminApproval(approval, cred))) return null;
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
    const secret = await consumeAdminApprovalSecret(approval, cred);
    if (secret) out.oneTimeSecret = secret;
  }
  if (fulfillment.noticeJa) {
    out.noticeJa = fulfillment.noticeJa;
  } else if (fulfillment.oneTimeSecret) {
    out.noticeJa = "この秘密値は一度だけです。社員証 MCP に使い、管理 MCP のヘッダと混ぜないでください。";
  }
  if (fulfillment.nextStepJa) {
    out.nextStepJa = fulfillment.nextStepJa;
  }
  if (fulfillment.enabled !== undefined) {
    out.enabled = fulfillment.enabled;
  }
  if (fulfillment.destinationPresent !== undefined) {
    out.destinationPresent = fulfillment.destinationPresent;
  }
  if (fulfillment.webhookPath) {
    out.webhookPath = fulfillment.webhookPath;
  }
  if (fulfillment.orgId) {
    out.orgId = fulfillment.orgId;
  }
  if (fulfillment.ownerUserId) {
    out.ownerUserId = fulfillment.ownerUserId;
  }
  if (fulfillment.ownerEmail) {
    out.ownerEmail = fulfillment.ownerEmail;
  }
  if (fulfillment.trialEndsAt !== undefined) {
    out.trialEndsAt = fulfillment.trialEndsAt;
  }
  if (fulfillment.integrationMode) {
    out.integrationMode = fulfillment.integrationMode;
  }
  if (fulfillment.summaryJa) {
    out.summaryJa = fulfillment.summaryJa;
  }
  if (fulfillment.adminAgentId) {
    out.adminAgentId = fulfillment.adminAgentId;
  }
  return out;
}
