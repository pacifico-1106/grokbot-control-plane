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
  listEmployees,
  getEffectiveIngressHandoffPolicy,
  getEffectiveSchedulingPolicy,
  type IngressHandoffPolicySource,
  type SchedulingPolicySource,
} from "@/lib/data";
import { listConversationAdapters } from "@/lib/data/conversation-adapters";
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
import { listSlackImRoutesByOrg } from "@/lib/data/slack-im-routes";
import { getEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { buildEmployeePolicyDrafts } from "@/lib/employees/policy-draft";
import { parseRolesProposeInput } from "@/lib/mcp/roles-propose";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { ADMIN_AUDIT_CLASS } from "@/lib/admin-mcp/audit-class";
import { getEffectiveReplyPolicy, type ReplyPolicySource } from "@/lib/data/reply-policy";

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
      "Diagnose Slack integration status for this org (read-only, no approval required). Returns bot token presence, auth.test result, conversation adapter status, IM routes count, and employee posting_as settings with path-aware guidance. Use before guiding humans through Slack setup. The nextStepJa field indicates the next human action with posting_as pros/cons: Bot（会社窓口・アプリDM向け）vs 個人（社員名義・チャネル向け）。推奨デフォルト: アプリDM向け社員は bot / チャネル・Connect・人対人DM向けは user。【dual-audience S1+S2+S3本番】混在/Connect chでは resolveAudience が dualAudience を返却、二重マトリクス評価 dualEgress も稼働中。【F1 口ルーティング本番】S3/F1 口ルーティング本番稼働中。A1 scheduling.policy も本番稼働中。混在chは相手台帳必須（parties.upsert）。Refer to docs/tenant-slack-kickoff-rail.md for the full RAIL including F1 guidance.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ingressHandoff.get",
    description:
      "Read ingress handoff policy (read-only, no approval required). Omit employeeId for org policy; include for AI社員ごとの設定. Returns effective policy + source layer (employee/org/default) + layers (employeeOverride/orgPolicy). Staffpass = act boundary; Sealith = encrypted file handoff; no round-trip masking.",
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
      "Patch ingress handoff policy after human approval (always_human). Omit employeeId for org policy; include for AI社員ごとの設定. To clear employee override (inherit org), set clearOverride=true. Full replace of rules array. First-match rule ordering. Admin cannot self-approve. Convenience default: body=full, attachment=meta, sealith=off. 【高リスク警告】attachment=file + sealith=off + classified_external_sensitive は silent enable 禁止。テナント承諾 (highRiskConsentAt/By) + 監査に設定を残す。",
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
            },
            required: ["confirmAutomation"],
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

const SLACK_AUTH_TEST_TIMEOUT_MS = 5_000;

type SlackAuthTestResult = {
  ok: boolean;
  bot_id?: string;
  user_id?: string;
  team_id?: string;
  error?: string;
};

async function slackAuthTest(token: string): Promise<SlackAuthTestResult> {
  if (!token) {
    return { ok: false, error: "token_missing" };
  }
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(SLACK_AUTH_TEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as SlackAuthTestResult;
    return body;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "auth_test_failed" };
  }
}

type SlackStatusResult = {
  ok: boolean;
  botTokenPresent: boolean;
  authTest: SlackAuthTestResult | null;
  adapterEnabled: boolean;
  adapterLabel: string | null;
  imRoutesCount: number;
  employeePostingAsBot: number;
  employeePostingAsUser: number;
  pathAEmployees: number;
  pathBEmployees: number;
  postingMismatch: string[];
  issues: string[];
  nextStepJa: string;
};

async function runSlackStatusDiagnose(
  cred: ResolvedAdminCredential
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }> {
  const issues: string[] = [];

  const botToken = await resolveOrgSlackBotToken(cred.orgId);
  const botTokenPresent = Boolean(botToken);

  let authTest: SlackAuthTestResult | null = null;
  if (botTokenPresent) {
    authTest = await slackAuthTest(botToken);
    if (!authTest.ok) {
      issues.push(`auth.test 失敗: ${authTest.error || "unknown"}`);
    }
  } else {
    issues.push("Bot Token が設定されていません");
  }

  const adapters = await listConversationAdapters(cred.orgId);
  const slackAdapter = adapters.find((a) => a.surface === "slack");
  const adapterEnabled = slackAdapter?.enabled ?? false;
  const adapterLabel = slackAdapter?.label ?? null;
  if (!adapterEnabled) {
    issues.push("Slack 会話アダプタが無効です");
  }

  const imRoutes = await listSlackImRoutesByOrg(cred.orgId);
  const imRoutesCount = imRoutes.length;
  const employeesWithRoutes = new Set(imRoutes.map((r) => r.employeeId));

  const employees = await listEmployees(cred.orgId);
  let postingAsBot = 0;
  let postingAsUser = 0;
  let pathAEmployees = 0;
  let pathBEmployees = 0;
  const postingMismatch: string[] = [];

  for (const emp of employees) {
    if (emp.status !== "active") continue;
    const posting = emp.postingAs;
    if (posting === "bot") postingAsBot++;
    else if (posting === "user") postingAsUser++;
    else postingAsBot++;

    const hasRoute = employeesWithRoutes.has(emp.id);
    const identity = await getEmployeeSlackIdentity(emp.id);
    const hasLinkedIdentity = identity?.status === "linked";

    if (hasLinkedIdentity) {
      pathBEmployees++;
      if (posting === "bot" && hasRoute) {
        postingMismatch.push(
          `${emp.displayName}: Path B (linked identity) だが posting_as: bot。人↔人DMには user が必要`
        );
      }
    } else if (hasRoute) {
      pathAEmployees++;
      if (posting === "user") {
        postingMismatch.push(
          `${emp.displayName}: Path A (App DM route のみ) だが posting_as: user。Bot DMには bot が必要`
        );
      }
    }
  }

  if (postingMismatch.length > 0) {
    issues.push(...postingMismatch);
  }

  let nextStepJa = "Slack 設定は完了しています。混在/Connect chを使う場合は parties.upsert で相手台帳を登録してください（S1+S2+S3 dual-audience 本番、F1 口ルーティング本番稼働中）。詳細: docs/tenant-slack-kickoff-rail.md";
  if (!botTokenPresent) {
    nextStepJa =
      "Slack Bot Token (xoxb-...) をダッシュボード「設定 → 会話アダプタ → Slack」に登録してください。";
  } else if (authTest && !authTest.ok) {
    nextStepJa = `Bot Token の認証に失敗しました (${authTest.error})。トークンを再取得し、ダッシュボードで更新してください。`;
  } else if (!adapterEnabled) {
    nextStepJa = "ダッシュボード「設定 → 会話アダプタ → Slack」でアダプタを有効にしてください。";
  } else if (imRoutesCount === 0) {
    nextStepJa =
      "チャネル分類を設定してください。内部1:1には channels.classify で employeeId を指定します。混在/Connect chは mixed=true + parties.upsert（相手台帳必須）。S1+S2+S3 dual-audience 本番、F1 口ルーティング本番稼働中。詳細: docs/tenant-slack-kickoff-rail.md";
  } else if (postingMismatch.length > 0) {
    nextStepJa =
      "posting_as の設定を確認してください。【Bot】会社窓口・アプリDM向け・退席非依存。【個人(user)】社員名義・チャネル/人対人DM向け・OAuth依存。Path A (App DM) は bot、Path B (人↔人DM) / チャネル・Connect は user。混在chは相手台帳必須。F1 口ルーティング本番稼働中（分離配信が有効）。詳細: docs/tenant-slack-kickoff-rail.md";
  }

  const result: SlackStatusResult = {
    ok: issues.length === 0,
    botTokenPresent,
    authTest,
    adapterEnabled,
    adapterLabel,
    imRoutesCount,
    employeePostingAsBot: postingAsBot,
    employeePostingAsUser: postingAsUser,
    pathAEmployees,
    pathBEmployees,
    postingMismatch,
    issues,
    nextStepJa,
  };

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

  if (name === "setup.slackStatus") {
    return runSlackStatusDiagnose(cred);
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
