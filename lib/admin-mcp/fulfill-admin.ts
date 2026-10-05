import { recordSetupToolSucceeded } from "@/lib/approvals/attachment-retry-cap";
import { buildMcpHandoff, parseMcpHandoff, type McpHandoff } from "@/lib/mcp/endpoint-handoff-block";
import { isMcpEndpointHandoffEnabled } from "@/lib/feature-flags";
import { isDemoMode } from "@/lib/mode";
import { executeApproval } from "@/lib/approvals/execution";
import { fulfillWorkflowMutation } from "@/lib/approval-workflow/admin";
import {
  fulfillApprovalRoutesPatch as fulfillApprovalRoutesPatchHandler,
  fulfillDeputyActivate as fulfillDeputyActivateHandler,
} from "@/lib/approval-kind-routes/mcp-handlers";
import { setOrgInternalAudienceRule, validateInternalAudienceRulePatch } from "@/lib/data/internal-audience-rule";
/**
 * Fulfill admin MCP tickets after a different human approves.
 * Uses the existing issueEmployee / linkAgent / updateEmployeePolicy /
 * upsertOrgParty / upsertOrgChannel paths — no second mutation skip.
 */
import { createHash, randomBytes } from "node:crypto";
import { normalizeActionLimits } from "@/lib/action-gate";
import {
  appendAuditEvent,
  getEmployee,
  issueEmployee,
  updateEmployeePolicy,
  setOrgIngressHandoffPolicy,
  setEmployeeIngressHandoffPolicy,
  setOrgSchedulingPolicy,
  setEmployeeSchedulingPolicy,
  setOrgReplyPolicy,
  setEmployeeReplyPolicy,
  setOrgMailPolicy,
  setEmployeeMailPolicy,
  getOrgStuckWatchPolicy,
  setOrgStuckWatchPolicy,
  upsertConversationAdapter,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data";
import { decryptNotificationSecrets } from "@/lib/notify/crypto";
import { DASHBOARD_BOT_TOKEN_PATH_JA, slackAuthTest } from "@/lib/slack/slack-status-diagnose";
import {
  mapLineApprovalChannelStatus,
  WEBHOOK_REGISTER_HINT_JA,
} from "@/lib/line/line-approval-status-diagnose";
import { updateApprovalMetadata } from "@/lib/data/approvals";
import { validateIngressHandoffPolicy } from "@/lib/ingress-handoff/validate";
import { validateSchedulingPolicy } from "@/lib/scheduling-policy/validate";
import { validateReplyPolicy } from "@/lib/gateway/reply-policy-validate";
import { validateMailPolicy } from "@/lib/mail-policy/validate";
import { normalizeStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import { linkAgent } from "@/lib/data/bindings";
import { upsertOrgParty } from "@/lib/data/directory";
import { onSlackUserPartyUpserted } from "@/lib/slack/dm-autoroute";
import { applyChannelClassification } from "@/lib/admin-mcp/channel-classify";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { normalizeApproverUserIds, parseApprovalChannelId } from "@/lib/employees/approval-inbox";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { employeePolicyWriteFailure } from "@/lib/employees/policy-errors";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { ADMIN_AUDIT_CLASS, auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { fulfillOrgCreateFromQueuedArgs } from "@/lib/admin-mcp/orgs-create";
import { fulfillOrgIssueAdminCredentialFromQueuedArgs } from "@/lib/admin-mcp/orgs-issue-admin-credential";
import {
  createPendingVoterBinding,
  revokeVoterBinding,
  isTelegramGlobalChannelKey,
  type VoterBindingProvider,
} from "@/lib/approval-workflow/voter-binding";
import { sendVerificationDmToSlackUser } from "@/lib/approval-workflow/voter-binding-verification";
import {
  sendVerificationToTelegramUser,
  sendVerificationToTelegramUserViaChannel,
  sendVerificationToTelegramGroup,
} from "@/lib/approval-workflow/telegram-binding-verification";
import { getNotificationChannelSecretsById } from "@/lib/data/notification-channels";
import type { PlatformOpsActor } from "@/lib/admin/platform-ops-gate";
import {
  createCardSetupSession,
  buildCardSetupMouthResponse,
} from "@/lib/external-contract-card/checkout-setup";
import {
  createPortalLink,
  buildPortalLinkMouthResponse,
} from "@/lib/external-contract-card/portal-link";
import {
  isCardSetupApproval,
} from "@/lib/external-contract-card/queue-card-setup";
import {
  isPortalLinkApproval,
} from "@/lib/external-contract-card/queue-portal-link";
import {
  upsertIdentityBinding,
  bindMailbox,
  getIdentityBinding,
} from "@/lib/employees/employee-identity";
import type {
  ActionLimits,
  AllowedAccount,
  ApprovalPolicy,
  ApprovalRequest,
  EmployeeScope,
  SpendLimits,
} from "@/lib/types";
import { validateChannelsClassifyArgs, validatePartiesUpsertArgs } from "@/lib/channel-classify/core";

export type AdminFulfillment = {
  ok: boolean;
  tool: string;
  at: string;
  error?: string;
  employeeId?: string;
  secretPrefix?: string;
  /** Present once after hire fulfill; stripped after first read. */
  oneTimeSecret?: string;
  partyId?: string;
  channelId?: string;
  draft?: unknown;
  nextStepJa?: string;
  noticeJa?: string;
  adapterId?: string;
  surface?: string;
  enabled?: boolean;
  hasCredentials?: boolean;
  botTokenPresent?: boolean;
  authTest?: { ok: boolean; error?: string | null };
  destinationPresent?: boolean;
  webhookPath?: string;
  orgId?: string;
  ownerUserId?: string;
  ownerEmail?: string;
  trialEndsAt?: string | null;
  integrationMode?: string;
  summaryJa?: string;
  adminAgentId?: string;
  /** setup.slackAuthorizeLink.issue: who actually received the link (no URL). */
  deliveryTarget?: "employee" | "approver";
  deliveryFallbackReason?: string | null;
  /** MCP_ENDPOINT_HANDOFF_ENABLED: secret-free MCP endpoint + connection steps (issue / link). */
  mcpHandoff?: McpHandoff;
};

/** issue / link: attach the shared MCP handoff block (flag OFF → nothing). */
function mcpHandoffFields(employeeId: string, nextStepJa?: string): Pick<AdminFulfillment, "mcpHandoff" | "nextStepJa"> {
  if (!isMcpEndpointHandoffEnabled()) return nextStepJa === undefined ? {} : { nextStepJa };
  const mcpHandoff = buildMcpHandoff({ employeeId });
  const line = `MCP 接続先: ${mcpHandoff.mcp.url}（Streamable HTTP、Authorization: Bearer に社員証）。接続確認は staffpass_whoami。詳細は mcpHandoff を参照。`;
  return { mcpHandoff, nextStepJa: nextStepJa ? `${nextStepJa} ${line}` : line };
}

const TOOL_NEXTSTEP_JA: Record<string, string> = {
  "employees.issue":
    "次は手足をこの社員証につなぎます。Grok Botを1体用意して、管理MCPの link に grokBotAgentId を渡してください。人がやるのは承認タップだけです。社員証の秘密はチャットに貼らない。連携後、Slackの口を設定する場合は setup.slackStatus で現状を診断し、docs/tenant-slack-kickoff-rail.md の手順に従ってください。",
  link: "次はコネクタ認証です（OAuthは人がタップ、承認チケットとは別）。Slackの口を設定する場合は setup.slackStatus で現状を診断し、channels.classify で employeeId を指定してください。詳細: docs/tenant-slack-kickoff-rail.md",
  "setup.slackAdapter.setBotToken":
    `Bot token を登録しました。setup.slackStatus で botTokenPresent / authTest / adapterEnabled を確認してください。これは会話投稿アダプタ（「${DASHBOARD_BOT_TOKEN_PATH_JA}」）であり、「承認を受け取る」のSlackではありません。`,
  "setup.lineApproval.upsert":
    "承認用 LINE チャネルを登録しました。setup.lineApprovalStatus で webhookUrlTemplate を確認し、LINE Developers に Webhook URL を貼ってください。",
  "setup.lineApproval.setEmployeeInbox":
    "AI 社員の承認インボックスを更新しました。setup.lineApprovalStatus の employeeInboxSummary で割り当てを確認してください。",
  "setup.lineApproval.demoteTelegram":
    "Telegram 承認チャネルを無効化しました。setup.lineApprovalStatus で telegramApprovalEnabled=false を確認してください。",
  "orgs.create":
    "テナントを作成しました。次は employees.issue で AI社員を発行してください（新 org の gb_adm_ は別途発行）。",
  "orgs.issueAdminCredential":
    "対象 org の gb_adm_ を発行しました。Admin MCP ヘッダに設定してから employees.issue 等を実行してください。",
};

const TOOL_NOTICE_JA: Record<string, string> = {
  link: "紐付け完了。次はコネクタ認証（OAuthは人がタップ、承認チケットとは別）。Slackを使う場合は setup.slackStatus で診断してください。",
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function issueSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 14) };
}

function asScopes(value: unknown): EmployeeScope[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((scope) => ALL_SCOPES.includes(scope as EmployeeScope)) as EmployeeScope[];
}

function resolveQueuedBotToken(args: Record<string, unknown>): string {
  const ciphertext = String(args.botTokenCiphertext || "").trim();
  if (!ciphertext) return "";
  return decryptNotificationSecrets(ciphertext).botToken?.trim() || "";
}

function resolveQueuedLineSecrets(args: Record<string, unknown>): {
  channelAccessToken: string;
  channelSecret: string;
} {
  const ciphertext = String(args.secretsCiphertext || "").trim();
  if (!ciphertext) return { channelAccessToken: "", channelSecret: "" };
  const decrypted = decryptNotificationSecrets(ciphertext);
  return {
    channelAccessToken: decrypted.channelAccessToken?.trim() || "",
    channelSecret: decrypted.channelSecret?.trim() || "",
  };
}

function normalizeAllowedUserIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  return [...new Set(list.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

async function fulfillSlackAdapterSetBotToken(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const enabled = args.enabled !== false;
  const botToken = resolveQueuedBotToken(args);
  const label = typeof args.label === "string" ? args.label.trim() : "";

  if (enabled && !botToken) {
    throw new Error("slack_adapter_token_required");
  }
  if (botToken && !botToken.startsWith("xoxb-")) {
    throw new Error("invalid_bot_token_format");
  }

  const saved = await upsertConversationAdapter({
    orgId: approval.orgId,
    surface: "slack",
    label,
    enabled,
    config: {},
    secrets: botToken ? { botToken } : undefined,
  });

  const authTest = botToken ? await slackAuthTest(botToken) : null;

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.conversationAdapter",
    purpose: "admin.conversationAdapter",
    summary: `Slack 会話投稿アダプタを${enabled ? "更新" : "無効化"}（管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      adapterId: saved.id,
      surface: "slack",
      enabled,
      botTokenPresent: Boolean(botToken || saved.hasCredentials),
      authTestOk: authTest?.ok ?? null,
    },
  });

  return {
    ok: true,
    tool: "setup.slackAdapter.setBotToken",
    at: new Date().toISOString(),
    nextStepJa: TOOL_NEXTSTEP_JA["setup.slackAdapter.setBotToken"],
    noticeJa: `会話投稿アダプタ（「${DASHBOARD_BOT_TOKEN_PATH_JA}」）を更新しました。「承認を受け取る」のSlackとは別です。`,
    adapterId: saved.id,
    surface: "slack",
    enabled,
    hasCredentials: saved.hasCredentials,
    botTokenPresent: Boolean(botToken || saved.hasCredentials),
    authTest: authTest ? { ok: authTest.ok, error: authTest.error ?? null } : undefined,
  };
}

async function fulfillLineApprovalUpsert(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const enabled = args.enabled !== false;
  const destinationId = String(args.destinationId || "").trim();
  const allowedUserIds = normalizeAllowedUserIds(args.allowedUserIds);
  const label = typeof args.label === "string" ? args.label.trim() : "";
  const isDefault = args.isDefault === true;
  const channelId = String(args.channelId || "").trim();
  const { channelAccessToken, channelSecret } = resolveQueuedLineSecrets(args);
  const channels = await listNotificationChannels(approval.orgId);
  const existing = channelId
    ? channels.find((channel) => channel.id === channelId && channel.provider === "line")
    : undefined;
  if (channelId && !existing) throw new Error("line_channel_not_found");

  if (enabled) {
    if (!destinationId) throw new Error("destination_required");
    const hasExistingCredentials = Boolean(existing?.hasCredentials);
    if (!channelAccessToken && !hasExistingCredentials) {
      throw new Error("line_credentials_incomplete");
    }
    if (!channelSecret && !hasExistingCredentials) {
      throw new Error("line_credentials_incomplete");
    }
  }

  const saved = await upsertNotificationChannel({
    orgId: approval.orgId,
    ...(existing?.id ? { id: existing.id } : {}),
    provider: "line",
    label,
    enabled,
    isDefault,
    config: { destinationId, allowedUserIds },
    secrets: {
      ...(channelAccessToken ? { channelAccessToken } : {}),
      ...(channelSecret ? { channelSecret } : {}),
    },
  });
  const publicChannel = mapLineApprovalChannelStatus(saved);

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary: `承認用 LINE チャネルを${enabled ? "更新" : "無効化"}（管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      channelId: saved.id,
      provider: "line",
      enabled,
      destinationPresent: publicChannel.destinationPresent,
      hasCredentials: saved.hasCredentials,
    },
  });

  return {
    ok: true,
    tool: "setup.lineApproval.upsert",
    at: new Date().toISOString(),
    channelId: saved.id,
    enabled,
    destinationPresent: publicChannel.destinationPresent,
    webhookPath: saved.webhookPath,
    nextStepJa: TOOL_NEXTSTEP_JA["setup.lineApproval.upsert"],
    noticeJa: WEBHOOK_REGISTER_HINT_JA,
  };
}

/**
 * updateEmployeePolicy threw (fail-closed write): report ok:false with the
 * code only (the storage detail stays in the server log, never in the
 * persisted fulfillment / MCP result). No success audit is written.
 */
function employeePolicyWriteFailedFulfillment(tool: string, employeeId: string, error: unknown): AdminFulfillment {
  const failure = employeePolicyWriteFailure(error);
  console.error(failure.code, tool, employeeId, error instanceof Error ? error.message : error);
  return {
    ok: false,
    tool,
    at: new Date().toISOString(),
    error: failure.code,
    employeeId,
    nextStepJa: failure.nextStepJa,
  };
}

async function fulfillLineApprovalSetEmployeeInbox(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  if (!employeeId) throw new Error("employee_id_required");
  const employee = await getEmployee(employeeId, approval.orgId);
  if (!employee) throw new Error("employee_not_found");

  const channels = await listNotificationChannels(approval.orgId);
  const parsed = parseApprovalChannelId(
    args.approvalChannelId,
    channels.filter((channel) => channel.provider === "line").map((channel) => channel.id)
  );
  if (!parsed.ok) throw new Error("line_approval_channel_not_found");

  let updated: Awaited<ReturnType<typeof updateEmployeePolicy>>;
  try {
    updated = await updateEmployeePolicy({
      orgId: approval.orgId,
      employeeId,
      scopes: employee.scopes,
      allowedPurposes: employee.allowedPurposes,
      approvalPolicy: employee.approvalPolicy,
      approvalChannelId: parsed.id,
    });
  } catch (error) {
    return employeePolicyWriteFailedFulfillment("setup.lineApproval.setEmployeeInbox", employeeId, error);
  }
  if (!updated) throw new Error("employee_not_found");

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: updated.credentialId,
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary: `${updated.displayName} の承認インボックスを${parsed.id ? "LINE チャネルへ割り当て" : "組織既定へ戻す"}（管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      approvalChannelId: parsed.id,
      provider: "line",
    },
  });

  return {
    ok: true,
    tool: "setup.lineApproval.setEmployeeInbox",
    at: new Date().toISOString(),
    employeeId,
    channelId: parsed.id ?? undefined,
    nextStepJa: TOOL_NEXTSTEP_JA["setup.lineApproval.setEmployeeInbox"],
  };
}

async function fulfillLineApprovalDemoteTelegram(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const mode = args.mode === "clearDefault" ? "clearDefault" : "disable";
  const channelId = String(args.channelId || "").trim();
  const channels = await listNotificationChannels(approval.orgId);
  const lineDefault = channels.find(
    (channel) => channel.provider === "line" && channel.enabled
  );
  let targets = channels.filter((channel) => channel.provider === "telegram" && channel.enabled);
  if (channelId) {
    targets = targets.filter((channel) => channel.id === channelId);
    if (targets.length === 0) throw new Error("telegram_channel_not_found");
  }
  if (mode === "clearDefault") {
    if (!lineDefault) throw new Error("line_default_required");
    targets = targets.filter((channel) => channel.isDefault);
  }

  const disabledIds: string[] = [];
  for (const channel of targets) {
    await upsertNotificationChannel({
      orgId: approval.orgId,
      id: channel.id,
      provider: "telegram",
      enabled: false,
      isDefault: false,
      config: channel.config,
    });
    disabledIds.push(channel.id);
  }

  if (lineDefault) {
    await upsertNotificationChannel({
      orgId: approval.orgId,
      id: lineDefault.id,
      provider: "line",
      enabled: true,
      isDefault: true,
      config: lineDefault.config,
    });
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary: `Telegram 承認チャネルを無効化（${disabledIds.length}件・管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      mode,
      disabledChannelIds: disabledIds,
      lineDefaultChannelId: lineDefault?.id ?? null,
    },
  });

  return {
    ok: true,
    tool: "setup.lineApproval.demoteTelegram",
    at: new Date().toISOString(),
    channelId: disabledIds[0],
    nextStepJa: TOOL_NEXTSTEP_JA["setup.lineApproval.demoteTelegram"],
    noticeJa:
      disabledIds.length > 0
        ? `${disabledIds.length} 件の Telegram 承認チャネルを無効化しました。`
        : "対象の Telegram 承認チャネルはありませんでした。",
  };
}

async function persist(approval: ApprovalRequest, fulfillment: AdminFulfillment): Promise<void> {
  const saved = await updateApprovalMetadata(approval, {
    fulfillment,
    adminFulfillment: fulfillment,
  });
  if (!saved && !isDemoMode()) throw new Error("approval_metadata_save_failed");
  approval.metadata = saved ? saved.metadata : { ...approval.metadata, fulfillment };
}

export function parseAdminFulfillment(
  metadata: Record<string, unknown> | null | undefined
): AdminFulfillment | null {
  const raw = metadata?.adminFulfillment ?? metadata?.fulfillment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return null;
  return {
    ok: rec.ok,
    tool: typeof rec.tool === "string" ? rec.tool : "",
    at: typeof rec.at === "string" ? rec.at : new Date().toISOString(),
    error: typeof rec.error === "string" ? rec.error : undefined,
    employeeId: typeof rec.employeeId === "string" ? rec.employeeId : undefined,
    secretPrefix: typeof rec.secretPrefix === "string" ? rec.secretPrefix : undefined,
    oneTimeSecret: typeof rec.oneTimeSecret === "string" ? rec.oneTimeSecret : undefined,
    partyId: typeof rec.partyId === "string" ? rec.partyId : undefined,
    channelId: typeof rec.channelId === "string" ? rec.channelId : undefined,
    draft: rec.draft,
    nextStepJa: typeof rec.nextStepJa === "string" ? rec.nextStepJa : undefined,
    noticeJa: typeof rec.noticeJa === "string" ? rec.noticeJa : undefined,
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : undefined,
    destinationPresent: typeof rec.destinationPresent === "boolean" ? rec.destinationPresent : undefined,
    webhookPath: typeof rec.webhookPath === "string" ? rec.webhookPath : undefined,
    orgId: typeof rec.orgId === "string" ? rec.orgId : undefined,
    ownerUserId: typeof rec.ownerUserId === "string" ? rec.ownerUserId : undefined,
    ownerEmail: typeof rec.ownerEmail === "string" ? rec.ownerEmail : undefined,
    trialEndsAt:
      rec.trialEndsAt === null || typeof rec.trialEndsAt === "string"
        ? (rec.trialEndsAt as string | null)
        : undefined,
    integrationMode:
      typeof rec.integrationMode === "string" ? rec.integrationMode : undefined,
    summaryJa: typeof rec.summaryJa === "string" ? rec.summaryJa : undefined,
    adminAgentId: typeof rec.adminAgentId === "string" ? rec.adminAgentId : undefined,
    deliveryTarget: rec.deliveryTarget === "employee" || rec.deliveryTarget === "approver" ? rec.deliveryTarget : undefined,
    deliveryFallbackReason:
      rec.deliveryFallbackReason === null || typeof rec.deliveryFallbackReason === "string"
        ? (rec.deliveryFallbackReason as string | null)
        : undefined,
    ...(parseMcpHandoff(rec.mcpHandoff) ? { mcpHandoff: parseMcpHandoff(rec.mcpHandoff) } : {}),
  };
}

async function fulfillIssue(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const displayName = String(args.displayName || "").trim();
  const roleLabel = String(args.roleLabel || "").trim();
  const scopes = asScopes(args.scopes);
  if (!displayName || !roleLabel || !scopes.length) {
    throw new Error("invalid_issue_payload");
  }
  const secret = issueSecret();
  const expiresInDays = Math.min(365, Math.max(1, Number(args.expiresInDays) || 30));
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const hasOrder = scopes.includes("commerce:order");
  const spend = hasOrder
    ? normalizeSpendLimits((args.spend as Partial<SpendLimits> | null) ?? {})
    : null;
  const result = await issueEmployee({
    orgId: approval.orgId,
    displayName,
    roleLabel,
    jobDescription: String(args.jobDescription || ""),
    scopes,
    allowedPurposes: Array.isArray(args.allowedPurposes)
      ? args.allowedPurposes.map(String).filter(Boolean)
      : [],
    approvalPolicy: (args.approvalPolicy as ApprovalPolicy) || "risk_based",
    toolApprovalDefaults: normalizeToolApprovalDefaults(args.toolApprovalDefaults),
    sodOverrideAcknowledged: args.sodOverrideAcknowledged === true,
    actionLimits: normalizeActionLimits(args.actionLimits as ActionLimits),
    spend,
    allowedAccounts: normalizeAllowedAccounts(
      Array.isArray(args.allowedAccounts) ? (args.allowedAccounts as AllowedAccount[]) : []
    ),
    approvalNotifyEmail: typeof args.approvalNotifyEmail === "string" ? args.approvalNotifyEmail : null,
    callbackUrl: typeof args.callbackUrl === "string" ? args.callbackUrl : null,
    managerId: typeof args.managerId === "string" ? args.managerId : null,
    voice: args.voice == null ? defaultVoice() : normalizeVoice(args.voice),
    projectAccess:
      args.projectAccess == null
        ? defaultProjectAccess()
        : normalizeProjectAccess(args.projectAccess),
    postingAs: normalizePostingAs(args.postingAs),
    approvalChannelId: typeof args.approvalChannelId === "string" ? args.approvalChannelId : null,
    approverUserIds: normalizeApproverUserIds(args.approverUserIds),
    secretHash: secret.hash,
    secretPrefix: secret.prefix,
    expiresAt,
    auditSummary: `${displayName} の社員証を発行（管理MCP・人承認後）`,
    actorEmail: approval.resolvedBy ?? null,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: result.employee.id,
    credentialId: result.credentialId,
    action: "admin.hire",
    purpose: "admin.hire",
    summary: `${displayName} を人確認のうえで発行`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      secretHashPrefix: secret.hash.slice(0, 12),
    },
  });
  return {
    ok: true,
    tool: "employees.issue",
    at: new Date().toISOString(),
    employeeId: result.employee.id,
    secretPrefix: secret.prefix,
    oneTimeSecret: secret.raw,
    ...mcpHandoffFields(result.employee.id, TOOL_NEXTSTEP_JA["employees.issue"]),
  };
}

async function fulfillLink(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const grokBotAgentId = String(args.grokBotAgentId || "").trim();
  if (!employeeId || !grokBotAgentId) throw new Error("invalid_link_payload");
  const binding = await linkAgent(employeeId, {
    orgId: approval.orgId,
    grokBotAgentId,
    grokBotWorkspaceId: typeof args.grokBotWorkspaceId === "string" ? args.grokBotWorkspaceId : null,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: null,
    action: "admin.link",
    purpose: "admin.link",
    summary: "Grok Bot エージェントを連携（人承認後）",
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      grokBotAgentId: binding.grokBotAgentId,
    },
  });
  return {
    ok: true,
    tool: "link",
    at: new Date().toISOString(),
    employeeId,
    noticeJa: TOOL_NOTICE_JA.link,
    ...mcpHandoffFields(employeeId, TOOL_NEXTSTEP_JA.link),
  };
}

/** ADMIN_MCP_ALLOWED_ACCOUNTS_TOOLS_ENABLED: human-approved allowedAccounts add/remove. */
async function fulfillAllowedAccountsTicket(
  approval: ApprovalRequest,
  args: Record<string, unknown>,
  tool: "employees.allowedAccounts.add" | "employees.allowedAccounts.remove"
): Promise<AdminFulfillment> {
  const { fulfillAllowedAccountsChange } = await import("@/lib/admin-mcp/allowed-accounts-tools");
  const result = await fulfillAllowedAccountsChange(approval, tool, args);
  const at = new Date().toISOString();
  if (!result.ok) {
    return {
      ok: false,
      tool,
      at,
      error: result.code,
      nextStepJa: result.nextStepJa ? `${result.messageJa}${result.nextStepJa}` : result.messageJa,
      ...(result.noticeJa ? { noticeJa: result.noticeJa } : {}),
    };
  }
  return {
    ok: true,
    tool,
    at,
    employeeId: result.employeeId,
    summaryJa: result.summaryJa,
    nextStepJa: result.nextStepJa ?? "employees.allowedAccounts.list で現在の許可アカウントを確認できます。",
    ...(result.noticeJa ? { noticeJa: result.noticeJa } : {}),
  };
}

/** PR-D: owner-approved 指定管理者 list; re-validated and owner-checked right before the write. */
async function fulfillDesignatedAdminsTicket(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const { fulfillDesignatedAdminsSet, DESIGNATED_ADMINS_SET_TOOL } = await import("@/lib/admin-mcp/designated-admins-tool");
  const result = await fulfillDesignatedAdminsSet(approval, args);
  const at = new Date().toISOString();
  if (!result.ok) return { ok: false, tool: DESIGNATED_ADMINS_SET_TOOL, at, error: result.code, nextStepJa: result.messageJa };
  return { ok: true, tool: DESIGNATED_ADMINS_SET_TOOL, at, summaryJa: result.summaryJa };
}

/** オーナー追加: owner-approved; approver ≠ requester / target and the member guard re-checked right before the write. */
async function fulfillPromoteOwnerTicket(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const { fulfillPromoteOwner, PROMOTE_OWNER_TOOL } = await import("@/lib/admin-mcp/promote-owner-tool");
  const result = await fulfillPromoteOwner(approval, args);
  const at = new Date().toISOString();
  if (!result.ok) return { ok: false, tool: PROMOTE_OWNER_TOOL, at, error: result.code, nextStepJa: result.messageJa };
  return { ok: true, tool: PROMOTE_OWNER_TOOL, at, summaryJa: result.summaryJa };
}

/** Human-approved Slack posting identity switch (bot | user); re-checked right before the write. */
async function fulfillPostingIdentityTicket(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const { fulfillPostingIdentityChange, POSTING_IDENTITY_SET_TOOL } = await import("@/lib/admin-mcp/posting-identity-tool");
  const result = await fulfillPostingIdentityChange(approval, args);
  const at = new Date().toISOString();
  if (!result.ok) {
    return {
      ok: false,
      tool: POSTING_IDENTITY_SET_TOOL,
      at,
      error: result.code,
      ...(result.employeeId ? { employeeId: result.employeeId } : {}),
      nextStepJa: result.nextStepJa ? `${result.messageJa}${result.nextStepJa}` : result.messageJa,
    };
  }
  return {
    ok: true,
    tool: POSTING_IDENTITY_SET_TOOL,
    at,
    employeeId: result.employeeId,
    summaryJa: result.summaryJa,
    ...(result.nextStepJa ? { nextStepJa: result.nextStepJa } : {}),
  };
}

async function fulfillPolicy(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const scopes = asScopes(args.scopes);
  const approvalPolicy = args.approvalPolicy as ApprovalPolicy;
  if (!employeeId || !scopes.length || !["auto", "risk_based", "always_human"].includes(approvalPolicy)) {
    throw new Error("invalid_policy_payload");
  }
  let updated: Awaited<ReturnType<typeof updateEmployeePolicy>>;
  try {
    updated = await updateEmployeePolicy({
      orgId: approval.orgId,
      employeeId,
      scopes,
      allowedPurposes: Array.isArray(args.allowedPurposes)
        ? args.allowedPurposes.map(String).filter(Boolean)
        : [],
      approvalPolicy,
      toolApprovalDefaults:
        args.toolApprovalDefaults !== undefined
          ? normalizeToolApprovalDefaults(args.toolApprovalDefaults)
          : undefined,
      sodOverrideAcknowledged: args.sodOverrideAcknowledged === true,
      actionLimits: normalizeActionLimits(args.actionLimits as ActionLimits),
    });
  } catch (error) {
    return employeePolicyWriteFailedFulfillment("policy.patch", employeeId, error);
  }
  if (!updated) throw new Error("employee_not_found");
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: updated.credentialId,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `${updated.displayName} の権限を人確認のうえで更新`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, scopes: updated.scopes },
  });
  return { ok: true, tool: "policy.patch", at: new Date().toISOString(), employeeId };
}

async function fulfillParty(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  // Defense in depth (request-time validation is the first gate): refuse an
  // invalid kind / audience instead of coercing it.
  const checked = validatePartiesUpsertArgs(args);
  if (!checked.ok) throw new Error(checked.code);
  const party = await upsertOrgParty({
    orgId: approval.orgId,
    kind: checked.value.kind,
    identifier: checked.value.identifier,
    audience: checked.value.audience,
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.parties",
    purpose: "admin.parties",
    summary: `相手台帳を更新: ${party.identifier}`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, partyId: party.id },
  });
  // SLACK_DM_AUTOROUTE_ENABLED (default OFF; no-op otherwise). Derives DM routes
  // only from this human-approved classification; never throws, audits itself.
  await onSlackUserPartyUpserted({
    orgId: approval.orgId,
    kind: party.kind,
    identifier: party.identifier,
    audience: party.audience,
  });
  return { ok: true, tool: "parties.upsert", at: new Date().toISOString(), partyId: party.id };
}

async function fulfillChannel(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  // Defense in depth: an invalid surface / classification is refused here too
  // (never silently written as "unknown").
  const checked = validateChannelsClassifyArgs(args);
  if (!checked.ok) throw new Error(checked.code);
  const { surface, externalId, classification } = checked.value;
  const { channel, routeEmployeeId } = await applyChannelClassification({
    orgId: approval.orgId,
    surface,
    externalId,
    classification,
    mixed: checked.value.mixed,
    employeeId: String(args.employeeId || "").trim(),
    slackTeamId: String(args.slackTeamId || "").trim(),
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.channel",
    purpose: "admin.channel",
    summary: `チャネル分類: ${channel.externalId}`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id, channelId: channel.id },
  });
  return {
    ok: true,
    tool: "channels.classify",
    at: new Date().toISOString(),
    channelId: channel.id,
    employeeId: routeEmployeeId ?? undefined,
  };
}

function platformActorFromQueuedArgs(args: Record<string, unknown>): PlatformOpsActor {
  return {
    email: String(args.platformActorEmail || "platform@ops"),
    userId:
      typeof args.platformActorUserId === "string" && args.platformActorUserId.trim()
        ? args.platformActorUserId.trim()
        : null,
    orgId: String(args.platformActorOrgId || ""),
  };
}

async function fulfillVoterBind(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const memberId = String(args.memberId || "").trim();
  const provider = String(args.provider || "").trim() as VoterBindingProvider;
  const channelKey = String(args.channelKey || "").trim();
  const externalUserId = String(args.externalUserId || "").trim();
  const expiresInDays = typeof args.expiresInDays === "number" ? args.expiresInDays : undefined;

  if (!memberId || !provider || !channelKey || !externalUserId) {
    throw new Error("missing_required_fields");
  }

  const bindResult = await createPendingVoterBinding({
    orgId: approval.orgId,
    provider,
    channelKey,
    externalUserId,
    memberId,
    expiresInDays,
  });

  if (!bindResult.ok) {
    return {
      ok: false,
      tool: "approvalWorkflow.bindVoter",
      at: new Date().toISOString(),
      error: bindResult.reason,
    };
  }

  const org = { name: "Staffpass組織", displayName: "" };
  const memberName = `メンバー ${memberId.slice(0, 8)}`;
  let nextStepJa = "確認ボタンをクリックして、バインディングを有効化してください。";

  if (provider === "slack") {
    const channelSecrets = await getNotificationChannelSecretsById(approval.orgId, channelKey);
    if (channelSecrets.botToken) {
      await sendVerificationDmToSlackUser({
        botToken: channelSecrets.botToken,
        slackUserId: externalUserId,
        orgId: approval.orgId,
        channelKey,
        memberId,
        memberDisplayName: memberName,
        orgName: org.name,
        verificationCode: bindResult.verificationCode,
      });
      nextStepJa = "Slack DMで送信された確認ボタンをクリックして、バインディングを有効化してください。";
    }
  } else if (provider === "telegram" && isTelegramGlobalChannelKey(channelKey)) {
    const telegramResult = await sendVerificationToTelegramUser({
      telegramUserId: externalUserId,
      orgId: approval.orgId,
      memberId,
      memberDisplayName: memberName,
      orgName: org.name,
      verificationCode: bindResult.verificationCode,
      verificationNonce: bindResult.verificationNonce,
      channelKey,
    });
    if (telegramResult.ok) {
      nextStepJa = "Telegram DMで送信された確認ボタンをクリックして、バインディングを有効化してください。";
    } else {
      nextStepJa = `Telegram DMの送信に失敗しました（${telegramResult.error}）。Telegram Bot が正しく設定されているか確認してください。`;
    }
  } else if (provider === "telegram") {
    const channelSecrets = await getNotificationChannelSecretsById(approval.orgId, channelKey);
    const channels = await listNotificationChannels(approval.orgId);
    const channel = channels.find((ch) => ch.id === channelKey && ch.provider === "telegram");
    const chatId = String(channel?.config?.chatId || "").trim();
    const isGroupChat = chatId.startsWith("-");

    if (channelSecrets.botToken) {
      const telegramResult = await sendVerificationToTelegramUserViaChannel({
        telegramUserId: externalUserId,
        orgId: approval.orgId,
        memberId,
        memberDisplayName: memberName,
        orgName: org.name,
        verificationCode: bindResult.verificationCode,
        verificationNonce: bindResult.verificationNonce,
        channelId: channelKey,
        botToken: channelSecrets.botToken,
        chatId,
      });

      if (telegramResult.ok) {
        nextStepJa = isGroupChat
          ? "グループチャットに確認ボタンを送信しました。本人のみがクリックできます。グループ内のボタンをクリックしてバインディングを有効化してください。"
          : "Telegramチャットで送信された確認ボタンをクリックして、バインディングを有効化してください。";
      } else if (telegramResult.error === "chat_not_reachable") {
        nextStepJa = telegramResult.nextStepJa || (isGroupChat
          ? `グループチャットに送信できません。Botがグループに追加されているか確認してください。`
          : `Telegramチャットに送信できません。ユーザーがBotを開始しているか確認してください。`);
      } else if (telegramResult.nextStepJa) {
        nextStepJa = telegramResult.nextStepJa;
      } else {
        nextStepJa = `Telegramへの送信に失敗しました（${telegramResult.error}）。チャネルのBot設定を確認してください。`;
      }
    } else {
      nextStepJa = `Telegramチャネル ${channelKey} のBot Tokenが設定されていません。通知チャネルの設定を確認してください。`;
    }
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `承認者バインディング作成（${provider}・管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      provider,
      channelKey,
      externalUserId,
      memberId,
      status: "pending",
      expiresAt: bindResult.binding.expiresAt,
    },
  });

  return {
    ok: true,
    tool: "approvalWorkflow.bindVoter",
    at: new Date().toISOString(),
    nextStepJa,
  };
}

async function fulfillVoterUnbind(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const provider = String(args.provider || "").trim() as VoterBindingProvider;
  const channelKey = String(args.channelKey || "").trim();
  const externalUserId = String(args.externalUserId || "").trim();

  if (!provider || !channelKey || !externalUserId) {
    throw new Error("missing_required_fields");
  }

  const revokeResult = await revokeVoterBinding(
    approval.orgId,
    provider,
    channelKey,
    externalUserId
  );

  if (!revokeResult.ok) {
    return {
      ok: false,
      tool: "approvalWorkflow.unbindVoter",
      at: new Date().toISOString(),
      error: revokeResult.reason,
    };
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `承認者バインディング取り消し（${provider}・管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      provider,
      channelKey,
      externalUserId,
      status: "revoked",
    },
  });

  return {
    ok: true,
    tool: "approvalWorkflow.unbindVoter",
    at: new Date().toISOString(),
    nextStepJa: "バインディングを取り消しました。このユーザーは承認ワークフローで投票できなくなります。",
  };
}

async function fulfillOrgCreate(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const actor = platformActorFromQueuedArgs(args);
  const created = await fulfillOrgCreateFromQueuedArgs(args, actor);

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.create_org",
    purpose: "admin.create_org",
    summary: created.summaryJa,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      orgId: created.orgId,
      orgName: String(args.orgName || ""),
      ownerEmail: created.ownerEmail,
      integrationMode: created.integrationMode,
      trialDays: args.trialDays ?? 14,
      actorEmail: actor.email,
      actorUserId: actor.userId,
      recovered: created.recovered === true,
      ownerPasswordPresent: args.ownerPasswordPresent === true,
    },
  });

  return {
    ok: true,
    tool: "orgs.create",
    at: new Date().toISOString(),
    orgId: created.orgId,
    ownerUserId: created.ownerUserId,
    ownerEmail: created.ownerEmail,
    trialEndsAt: created.trialEndsAt,
    integrationMode: created.integrationMode,
    summaryJa: created.summaryJa,
    nextStepJa: created.nextStepJa || TOOL_NEXTSTEP_JA["orgs.create"],
  };
}

async function fulfillOrgIssueAdminCredential(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const actor = platformActorFromQueuedArgs(args);
  const issued = await fulfillOrgIssueAdminCredentialFromQueuedArgs(args, actor);

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: issued.adminAgentId,
    action: "admin.issue_admin_credential",
    purpose: "admin.issue_admin_credential",
    summary: issued.summaryJa,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      targetOrgId: issued.targetOrgId,
      secretPrefix: issued.secretPrefix,
      generation: issued.credentialGeneration,
      actorEmail: actor.email,
      actorUserId: actor.userId,
    },
  });

  return {
    ok: true,
    tool: "orgs.issueAdminCredential",
    at: new Date().toISOString(),
    orgId: issued.targetOrgId,
    adminAgentId: issued.adminAgentId,
    secretPrefix: issued.secretPrefix,
    oneTimeSecret: issued.oneTimeSecret,
    summaryJa: issued.summaryJa,
    nextStepJa: issued.nextStepJa || TOOL_NEXTSTEP_JA["orgs.issueAdminCredential"],
    noticeJa: issued.noticeJa,
  };
}

async function fulfillRolePropose(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const draft = args.draft ?? args.proposedPolicy ?? null;
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.role",
    purpose: "admin.role",
    summary: "職務案を人確認しました（発行は別チケット）",
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id },
  });
  return {
    ok: true,
    tool: "roles.propose",
    at: new Date().toISOString(),
    draft,
  };
}

async function fulfillIngressHandoff(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;
  const clearOverride = args.clearOverride === true;

  if (clearOverride && employeeId) {
    await setEmployeeIngressHandoffPolicy(employeeId, approval.orgId, null);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.ingressHandoff",
      purpose: "admin.ingressHandoff",
      summary: `AI社員の受信の渡し方オーバーライドをクリアしました（組織ポリシーを継承）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        cleared: true,
      },
    });
    return {
      ok: true,
      tool: "ingressHandoff.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const validation = validateIngressHandoffPolicy({
    policyName: args.policyName,
    rules: args.rules,
    highRiskConsentAt: args.highRiskConsentAt,
    highRiskConsentBy: args.highRiskConsentBy,
  });
  if (!validation.ok) {
    throw new Error("invalid_ingress_handoff_policy");
  }

  const hasHighRiskConsent = Boolean(validation.policy.highRiskConsentAt);

  if (employeeId) {
    const policy = await setEmployeeIngressHandoffPolicy(employeeId, approval.orgId, validation.policy);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.ingressHandoff",
      purpose: "admin.ingressHandoff",
      summary: `AI社員ごとの受信の渡し方オーバーライドを設定しました（${policy?.rules.length ?? 0}ルール）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        policyId: policy?.policyId,
        policyName: policy?.policyName,
        rulesCount: policy?.rules.length ?? 0,
        highRiskConsentAt: policy?.highRiskConsentAt,
        highRiskConsentBy: policy?.highRiskConsentBy,
      },
    });
    return {
      ok: true,
      tool: "ingressHandoff.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const policy = await setOrgIngressHandoffPolicy(approval.orgId, validation.policy);
  const consentNote = hasHighRiskConsent ? "（高リスク承諾あり）" : "";
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.ingressHandoff",
    purpose: "admin.ingressHandoff",
    summary: `組織の受信の渡し方ポリシーを更新しました（${policy.rules.length}ルール${consentNote}）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      policyId: policy.policyId,
      policyName: policy.policyName,
      rulesCount: policy.rules.length,
      highRiskConsentAt: policy.highRiskConsentAt,
      highRiskConsentBy: policy.highRiskConsentBy,
    },
  });
  return {
    ok: true,
    tool: "ingressHandoff.patch",
    at: new Date().toISOString(),
  };
}

async function fulfillSchedulingPolicy(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;
  const clearOverride = args.clearOverride === true;

  if (clearOverride && employeeId) {
    await setEmployeeSchedulingPolicy(employeeId, approval.orgId, null);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員のスケジューリングポリシーオーバーライドをクリアしました（組織ポリシーを継承）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        cleared: true,
      },
    });
    return {
      ok: true,
      tool: "schedulingPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const validation = validateSchedulingPolicy({
    policyName: args.policyName,
    rules: args.rules,
    regionDictionary: args.regionDictionary,
    highRiskConsentAt: args.highRiskConsentAt,
    highRiskConsentBy: args.highRiskConsentBy,
  });
  if (!validation.ok) {
    throw new Error("invalid_scheduling_policy");
  }

  const hasHighRiskConsent = Boolean(validation.policy.highRiskConsentAt);

  if (employeeId) {
    const policy = await setEmployeeSchedulingPolicy(employeeId, approval.orgId, validation.policy);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員ごとのスケジューリングポリシーオーバーライドを設定しました（${policy?.rules.length ?? 0}ルール）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        policyId: policy?.policyId,
        policyName: policy?.policyName,
        rulesCount: policy?.rules.length ?? 0,
        highRiskConsentAt: policy?.highRiskConsentAt,
        highRiskConsentBy: policy?.highRiskConsentBy,
      },
    });
    return {
      ok: true,
      tool: "schedulingPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const policy = await setOrgSchedulingPolicy(approval.orgId, validation.policy);
  const consentNote = hasHighRiskConsent ? "（高リスク承諾あり）" : "";
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `組織のスケジューリングポリシーを更新しました（${policy.rules.length}ルール${consentNote}）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      policyId: policy.policyId,
      policyName: policy.policyName,
      rulesCount: policy.rules.length,
      highRiskConsentAt: policy.highRiskConsentAt,
      highRiskConsentBy: policy.highRiskConsentBy,
    },
  });
  return {
    ok: true,
    tool: "schedulingPolicy.patch",
    at: new Date().toISOString(),
  };
}

async function fulfillReplyPolicy(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;
  const clearOverride = args.clearOverride === true;

  if (clearOverride && employeeId) {
    await setEmployeeReplyPolicy(employeeId, approval.orgId, null);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員の返信ポリシーオーバーライドをクリアしました（組織ポリシーを継承）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        cleared: true,
      },
    });
    return {
      ok: true,
      tool: "replyPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const validation = validateReplyPolicy({
    policyName: args.policyName,
    rules: args.rules,
    highRiskConsentAt: args.highRiskConsentAt,
    highRiskConsentBy: args.highRiskConsentBy,
  });
  if (!validation.ok) {
    throw new Error("invalid_reply_policy");
  }

  const hasHighRiskConsent = Boolean(validation.policy.highRiskConsentAt);

  if (employeeId) {
    const policy = await setEmployeeReplyPolicy(employeeId, approval.orgId, validation.policy);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員ごとの返信ポリシーオーバーライドを設定しました（${policy?.rules.length ?? 0}ルール）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        policyId: policy?.policyId,
        policyName: policy?.policyName,
        rulesCount: policy?.rules.length ?? 0,
        highRiskConsentAt: policy?.highRiskConsentAt,
        highRiskConsentBy: policy?.highRiskConsentBy,
      },
    });
    return {
      ok: true,
      tool: "replyPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const policy = await setOrgReplyPolicy(approval.orgId, validation.policy);
  const consentNote = hasHighRiskConsent ? "（高リスク承諾あり）" : "";
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `組織の返信ポリシーを更新しました（${policy.rules.length}ルール${consentNote}）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      policyId: policy.policyId,
      policyName: policy.policyName,
      rulesCount: policy.rules.length,
      highRiskConsentAt: policy.highRiskConsentAt,
      highRiskConsentBy: policy.highRiskConsentBy,
    },
  });
  return {
    ok: true,
    tool: "replyPolicy.patch",
    at: new Date().toISOString(),
  };
}

async function fulfillMailPolicy(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = typeof args.employeeId === "string" && args.employeeId.trim()
    ? args.employeeId.trim()
    : null;
  const clearOverride = args.clearOverride === true;

  if (clearOverride && employeeId) {
    await setEmployeeMailPolicy(employeeId, approval.orgId, null);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員のメールポリシーオーバーライドをクリアしました（組織ポリシーを継承）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        cleared: true,
      },
    });
    return {
      ok: true,
      tool: "mailPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const validation = validateMailPolicy({
    policyName: args.policyName,
    rules: args.rules,
    highRiskConsentAt: args.highRiskConsentAt,
    highRiskConsentBy: args.highRiskConsentBy,
  });
  if (!validation.ok) {
    throw new Error("invalid_mail_policy");
  }

  const hasHighRiskConsent = Boolean(validation.policy.highRiskConsentAt);

  if (employeeId) {
    const policy = await setEmployeeMailPolicy(employeeId, approval.orgId, validation.policy);
    await appendAuditEvent({
      orgId: approval.orgId,
      employeeId,
      credentialId: null,
      action: "admin.policy",
      purpose: "admin.policy",
      summary: `AI社員ごとのメールポリシーオーバーライドを設定しました（${policy?.rules.length ?? 0}ルール）`,
      metadata: {
        auditClass: ADMIN_AUDIT_CLASS,
        approvalId: approval.id,
        employeeId,
        policyId: policy?.policyId,
        policyName: policy?.policyName,
        rulesCount: policy?.rules.length ?? 0,
        highRiskConsentAt: policy?.highRiskConsentAt,
        highRiskConsentBy: policy?.highRiskConsentBy,
      },
    });
    return {
      ok: true,
      tool: "mailPolicy.patch",
      at: new Date().toISOString(),
      employeeId,
    };
  }

  const policy = await setOrgMailPolicy(approval.orgId, validation.policy);
  const consentNote = hasHighRiskConsent ? "（高リスク承諾あり）" : "";
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `組織のメールポリシーを更新しました（${policy.rules.length}ルール${consentNote}）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      policyId: policy.policyId,
      policyName: policy.policyName,
      rulesCount: policy.rules.length,
      highRiskConsentAt: policy.highRiskConsentAt,
      highRiskConsentBy: policy.highRiskConsentBy,
    },
  });
  return {
    ok: true,
    tool: "mailPolicy.patch",
    at: new Date().toISOString(),
  };
}

async function fulfillStuckWatch(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const current = await getOrgStuckWatchPolicy(approval.orgId);
  const patch: Record<string, unknown> = {};
  if (args.enabled !== undefined) patch.enabled = args.enabled === true;
  if (args.mentionUnansweredMinutes !== undefined) {
    patch.mentionUnansweredMinutes = args.mentionUnansweredMinutes;
  }
  if (args.approvedUnfulfilledMinutes !== undefined) {
    patch.approvedUnfulfilledMinutes = args.approvedUnfulfilledMinutes;
  }
  if (args.maxAutoRetries !== undefined) patch.maxAutoRetries = args.maxAutoRetries;
  if (args.retryBackoffSeconds !== undefined) {
    patch.retryBackoffSeconds = args.retryBackoffSeconds;
  }
  if (args.autoRetryFaultClasses !== undefined) {
    patch.autoRetryFaultClasses = args.autoRetryFaultClasses;
  }
  if (args.notifyMouth !== undefined) patch.notifyMouth = args.notifyMouth;
  if (args.inferInternalAudienceFromLedger !== undefined) {
    patch.inferInternalAudienceFromLedger =
      args.inferInternalAudienceFromLedger === true;
  }

  const policy = await setOrgStuckWatchPolicy(
    approval.orgId,
    normalizeStuckWatchPolicy({ ...current, ...patch }),
    "admin_mcp"
  );

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `Stuck Watch ポリシーを更新しました（W2=${policy.approvedUnfulfilledMinutes}分・maxRetry=${policy.maxAutoRetries}）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      enabled: policy.enabled,
      mentionUnansweredMinutes: policy.mentionUnansweredMinutes,
      approvedUnfulfilledMinutes: policy.approvedUnfulfilledMinutes,
      maxAutoRetries: policy.maxAutoRetries,
      retryBackoffSeconds: policy.retryBackoffSeconds,
      autoRetryFaultClasses: policy.autoRetryFaultClasses,
      inferInternalAudienceFromLedger: policy.inferInternalAudienceFromLedger,
    },
  });

  return {
    ok: true,
    tool: "stuckWatch.patch",
    at: new Date().toISOString(),
  };
}

/**
 * Fulfill approval routes patch after always_human approval.
 * Re-runs validation, checks before-state match, and writes audit record.
 */
async function fulfillApprovalRoutesPatch(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const at = new Date().toISOString();
  const result = await fulfillApprovalRoutesPatchHandler(approval, args);

  if (!result.ok) {
    return {
      ok: false,
      tool: "approvalRoutes.patch",
      at,
      error: result.code,
      nextStepJa: result.message,
    };
  }

  return {
    ok: true,
    tool: "approvalRoutes.patch",
    at,
    summaryJa: result.message,
  };
}

/**
 * Fulfill decision.deputyActivate after always_human approval.
 * Re-validates self-approval and cross-org constraints at fulfill time.
 */
async function fulfillDeputyActivate(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const at = new Date().toISOString();
  const result = await fulfillDeputyActivateHandler(approval, args);

  if (!result.ok) {
    return {
      ok: false,
      tool: "decision.deputyActivate",
      at,
      error: result.code,
      nextStepJa: result.message,
    };
  }

  return {
    ok: true,
    tool: "decision.deputyActivate",
    at,
    summaryJa: result.message,
  };
}

/**
 * Fulfill card setup link mint after always_human approval.
 * Creates Stripe Checkout session (mode=setup) and returns the deep link.
 */
async function fulfillCardSetupLinkMint(
  approval: ApprovalRequest
): Promise<AdminFulfillment> {
  const result = await createCardSetupSession({
    orgId: approval.orgId,
    approvalId: approval.id,
    actorUserId: approval.resolvedBy || undefined,
    actorEmail: approval.resolvedBy || undefined,
  });

  if (!result.ok) {
    return {
      ok: false,
      tool: "cardSetup.mintLink",
      at: new Date().toISOString(),
      error: result.error,
      nextStepJa: result.nextStepJa,
    };
  }

  const mouthResponse = buildCardSetupMouthResponse(result);

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.external_contract_card",
    purpose: "admin.external_contract_card",
    summary: "外部契約カード登録リンクを発行（人承認後）",
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    },
  });

  return {
    ok: true,
    tool: "cardSetup.mintLink",
    at: new Date().toISOString(),
    nextStepJa: mouthResponse.nextStepJa,
    summaryJa: mouthResponse.messageJa,
    ...({
      linkUrl: mouthResponse.linkUrl,
      expiresAt: result.expiresAt,
      expiresInMinutes: mouthResponse.expiresInMinutes,
    } as Record<string, unknown>),
  };
}

/**
 * Fulfill portal link mint after always_human approval.
 * Creates Stripe Customer Portal session and returns the deep link.
 */
async function fulfillPortalLinkMint(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const result = await createPortalLink({
    orgId: approval.orgId,
    approvalId: approval.id,
    actorUserId: approval.resolvedBy || undefined,
    actorEmail: approval.resolvedBy || undefined,
  });

  if (!result.ok) {
    return {
      ok: false,
      tool: "cardSetup.mintPortalLink",
      at: new Date().toISOString(),
      error: result.error,
      nextStepJa: result.nextStepJa,
    };
  }

  const mouthResponse = buildPortalLinkMouthResponse(result);
  const portalPurpose = String(args.portalPurpose || "change");

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.portal",
    purpose: "admin.portal",
    summary: `支払い方法管理リンクを発行（${portalPurpose}・人承認後）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      portalPurpose,
      expiresInMinutes: result.expiresInMinutes,
    },
  });

  return {
    ok: true,
    tool: "cardSetup.mintPortalLink",
    at: new Date().toISOString(),
    nextStepJa: mouthResponse.nextStepJa,
    summaryJa: mouthResponse.messageJa,
    ...({
      linkUrl: mouthResponse.linkUrl,
      expiresInMinutes: mouthResponse.expiresInMinutes,
    } as Record<string, unknown>),
  };
}

async function fulfillEmployeeIdentityUpsert(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const responsibleMemberId = String(args.responsibleMemberId || "").trim();
  const mailboxId = args.mailboxId ? String(args.mailboxId).trim() : null;

  if (!employeeId || !responsibleMemberId) {
    throw new Error("missing_required_fields");
  }

  const result = await upsertIdentityBinding({
    orgId: approval.orgId,
    employeeId,
    responsibleMemberId,
    mailboxId,
  });

  if (!result.ok) {
    return {
      ok: false,
      tool: "employeeIdentity.upsert",
      at: new Date().toISOString(),
      error: result.code,
    };
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `AI社員アイデンティティバインディングを作成/更新（管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      employeeId,
      responsibleMemberId,
      mailboxId,
      bindingId: result.binding.id,
    },
  });

  return {
    ok: true,
    tool: "employeeIdentity.upsert",
    at: new Date().toISOString(),
    employeeId,
    nextStepJa: "アイデンティティバインディングを作成しました。必要に応じて employeeIdentity.bindMailbox でメールボックスをバインドしてください。",
  };
}

async function fulfillEmployeeIdentityBindMailbox(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const mailboxId = String(args.mailboxId || "").trim();

  if (!employeeId || !mailboxId) {
    throw new Error("missing_required_fields");
  }

  const existing = await getIdentityBinding(approval.orgId, employeeId);
  if (!existing) {
    return {
      ok: false,
      tool: "employeeIdentity.bindMailbox",
      at: new Date().toISOString(),
      error: "binding_not_found",
    };
  }

  const result = await bindMailbox({
    orgId: approval.orgId,
    employeeId,
    mailboxId,
  });

  if (!result.ok) {
    return {
      ok: false,
      tool: "employeeIdentity.bindMailbox",
      at: new Date().toISOString(),
      error: result.code,
    };
  }

  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId,
    credentialId: null,
    action: "admin.policy",
    purpose: "admin.policy",
    summary: `AI社員にメールボックスをバインド（管理MCP・人承認）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      approvalId: approval.id,
      employeeId,
      mailboxId,
      bindingId: result.binding.id,
    },
  });

  return {
    ok: true,
    tool: "employeeIdentity.bindMailbox",
    at: new Date().toISOString(),
    employeeId,
    nextStepJa: "メールボックスをバインドしました。AI社員の受信箱ルーティングが有効になります。",
  };
}

/** PR-4: human-approved dmAutoroute.run. Org is the approval row's org. */
async function fulfillDmAutorouteRun(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const { executeDmAutorouteRun } = await import("@/lib/admin-mcp/slack-dm-setup");
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  const run = await executeDmAutorouteRun(approval.orgId, employeeId);
  if (!run.ok) throw new Error(run.code);
  const counts = run.counts;
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: employeeId || null,
    credentialId: null,
    action: "admin.channel",
    purpose: "admin.channel",
    summary: `管理MCPから DM 自動ルートを実行（人承認 / ${run.employees.length} 名）`,
    metadata: {
      auditClass: ADMIN_AUDIT_CLASS,
      event: "admin_mcp.dm_autoroute.run",
      approvalId: approval.id,
      employeeIds: run.employees.map((e) => e.employeeId),
      counts,
    },
  });
  return {
    ok: true,
    tool: "dmAutoroute.run",
    at: new Date().toISOString(),
    ...(employeeId ? { employeeId } : {}),
    summaryJa: `DM 自動ルート: 作成 ${counts.created ?? 0} / 既存 ${counts.already_routed ?? 0} / スキップ ${counts.skipped ?? 0} / 失敗 ${counts.failed ?? 0}`,
    nextStepJa: "dmAutoroute.list で各相手の結果（skipped / failed の reason）を確認してください。",
  };
}

/** SLACK_SHARED_APPROVAL_APP_ENABLED: human-approved setup.slackApprover.set. */
async function fulfillSlackApproverSetTicket(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const { fulfillSlackApproverSet } = await import("@/lib/admin-mcp/slack-approver");
  const result = await fulfillSlackApproverSet({ orgId: approval.orgId, approvalId: approval.id, args });
  const at = new Date().toISOString();
  if (!result.ok) {
    return { ok: false, tool: "setup.slackApprover.set", at, error: result.code, nextStepJa: result.messageJa };
  }
  return {
    ok: true,
    tool: "setup.slackApprover.set",
    at,
    summaryJa: `Staffpass承認 の承認者を ${result.approverSlackUserId} に設定し、承認 DM に「設定しました」を送りました。`,
    nextStepJa: "テスト承認は不要です。最初に届いた本物の承認依頼のボタンで、そのまま承認・却下してください。",
  };
}

/**
 * SLACK_AUTHORIZE_LINK_ENABLED: human-approved setup.slackAuthorizeLink.issue.
 * The link URL is delivered only in the approval-app DM; never in this result.
 */
async function fulfillSlackAuthorizeLinkTicket(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const { fulfillSlackAuthorizeLinkIssue, issueNextStepJa } = await import("@/lib/admin-mcp/slack-authorize-link");
  const result = await fulfillSlackAuthorizeLinkIssue({ orgId: approval.orgId, approvalId: approval.id, args });
  const at = new Date().toISOString();
  if (!result.ok) {
    return {
      ok: false,
      tool: "setup.slackAuthorizeLink.issue",
      at,
      error: result.code,
      nextStepJa: result.messageJa,
    };
  }
  const to = result.deliveredTo;
  return {
    ok: true,
    tool: "setup.slackAuthorizeLink.issue",
    at,
    employeeId: result.employeeId,
    summaryJa:
      `Slack 再認可リンクを承認アプリの DM で${to.target === "employee" ? "社員本人" : "承認者"} ${to.deliveryUserId} に送りました` +
      `（${result.expiresAt} まで・1回限り${to.fallbackReason ? `・社員本人に送れないため承認者へ: ${to.fallbackReason}` : ""}）。URL は返しません。`,
    nextStepJa: issueNextStepJa(result),
    deliveryTarget: to.target,
    deliveryFallbackReason: to.fallbackReason,
  };
}

/** PR-4: human-approved setup.approvalDelivery.autoResolve (always_human). */
async function fulfillApprovalDeliveryAutoResolveTicket(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<AdminFulfillment> {
  const { fulfillApprovalDeliveryAutoResolve } = await import("@/lib/admin-mcp/slack-dm-setup");
  const result = await fulfillApprovalDeliveryAutoResolve({ orgId: approval.orgId, approvalId: approval.id, args });
  if (!result.ok) {
    return {
      ok: false,
      tool: "setup.approvalDelivery.autoResolve",
      at: new Date().toISOString(),
      error: result.code,
      nextStepJa: result.messageJa + (result.deepLink ? ` ${result.deepLink}` : ""),
    };
  }
  return {
    ok: true,
    tool: "setup.approvalDelivery.autoResolve",
    at: new Date().toISOString(),
    channelId: result.inboxId,
    destinationPresent: true,
    summaryJa: "承認口の宛先を承認 DM に設定し、「設定しました」を送りました。テスト承認は不要です。",
    nextStepJa: "最初の本物の承認依頼が実地確認です。届かない・押せないときは承認されず、管理者に通知されます。",
  };
}

/** ADMIN_MCP_DIRECTORY_REMOVE_TOOLS_ENABLED: human-approved channel / party ledger removal. */
async function fulfillDirectoryRemoveTicket(
  approval: ApprovalRequest,
  args: Record<string, unknown>,
  tool: "channels.remove" | "parties.remove"
): Promise<AdminFulfillment> {
  const { fulfillChannelRemove, fulfillPartyRemove } = await import("@/lib/admin-mcp/directory-remove-tools");
  const result = tool === "channels.remove" ? await fulfillChannelRemove(approval, args) : await fulfillPartyRemove(approval, args);
  const at = new Date().toISOString();
  if (!result.ok) return { ok: false, tool, at, error: result.code, nextStepJa: result.messageJa };
  return {
    ok: true,
    tool,
    at,
    ...(tool === "channels.remove" ? { channelId: result.id } : { partyId: result.id }),
    summaryJa: result.summaryJa,
  };
}

async function fulfillApprovedAdminCore(
  approval: ApprovalRequest
): Promise<AdminFulfillment | null> {
  if (!isAdminClassApproval(approval)) return null;
  if (approval.status !== "approved") return null;
  const existing = parseAdminFulfillment(approval.metadata);
  if (existing?.ok) return existing;
  const args = rec(approval.metadata?.adminMutation);
  const tool = String(approval.metadata?.adminTool || approval.tool || "");
  const at = new Date().toISOString();
  try {
    let fulfillment: AdminFulfillment;
    switch (tool) {
      case "employees.issue":
        fulfillment = await fulfillIssue(approval, args);
        break;
      case "link":
        fulfillment = await fulfillLink(approval, args);
        break;
      case "policy.patch":
        fulfillment = await fulfillPolicy(approval, args);
        break;
      case "employees.allowedAccounts.add":
      case "employees.allowedAccounts.remove":
        fulfillment = await fulfillAllowedAccountsTicket(approval, args, tool);
        break;
      case "employees.postingIdentity.set":
        fulfillment = await fulfillPostingIdentityTicket(approval, args);
        break;
      case "parties.upsert":
        fulfillment = await fulfillParty(approval, args);
        break;
      case "channels.classify":
        fulfillment = await fulfillChannel(approval, args);
        break;
      case "roles.propose":
        fulfillment = await fulfillRolePropose(approval, args);
        break;
      case "ingressHandoff.patch":
        fulfillment = await fulfillIngressHandoff(approval, args);
        break;
      case "schedulingPolicy.patch":
        fulfillment = await fulfillSchedulingPolicy(approval, args);
        break;
      case "replyPolicy.patch":
        fulfillment = await fulfillReplyPolicy(approval, args);
        break;
      case "mailPolicy.patch":
        fulfillment = await fulfillMailPolicy(approval, args);
        break;
      case "internalAudienceRule.patch": {
        const rule = validateInternalAudienceRulePatch(args);
        await setOrgInternalAudienceRule(approval.orgId, rule, approval.resolvedBy || "admin_mcp");
        await appendAuditEvent({ orgId: approval.orgId, employeeId: null, credentialId: null,
          action: "admin.policy", purpose: "admin.policy", summary: "社内判定ルールを更新（管理MCP・人承認）",
          metadata: { approvalId: approval.id, auditClass: ADMIN_AUDIT_CLASS, rule },
        });
        fulfillment = { ok: true, tool, at };
        break;
      }
      case "stuckWatch.patch":
        fulfillment = await fulfillStuckWatch(approval, args);
        break;
      case "approvalWorkflow.patch":
      case "approvalWorkflow.remind":
        fulfillment = await fulfillWorkflowMutation(approval, args, tool);
        break;
      case "approvalRoutes.patch":
        fulfillment = await fulfillApprovalRoutesPatch(approval, args);
        break;
      case "decision.deputyActivate":
        fulfillment = await fulfillDeputyActivate(approval, args);
        break;
      case "setup.slackAdapter.setBotToken":
        fulfillment = await fulfillSlackAdapterSetBotToken(approval, args);
        break;
      case "setup.lineApproval.upsert":
        fulfillment = await fulfillLineApprovalUpsert(approval, args);
        break;
      case "dmAutoroute.run":
        fulfillment = await fulfillDmAutorouteRun(approval, args);
        break;
      case "setup.approvalDelivery.autoResolve":
        fulfillment = await fulfillApprovalDeliveryAutoResolveTicket(approval, args);
        break;
      case "setup.slackApprover.set":
        fulfillment = await fulfillSlackApproverSetTicket(approval, args);
        break;
      case "setup.slackAuthorizeLink.issue":
        fulfillment = await fulfillSlackAuthorizeLinkTicket(approval, args);
        break;
      case "setup.lineApproval.setEmployeeInbox":
        fulfillment = await fulfillLineApprovalSetEmployeeInbox(approval, args);
        break;
      case "setup.lineApproval.demoteTelegram":
        fulfillment = await fulfillLineApprovalDemoteTelegram(approval, args);
        break;
      case "approvalWorkflow.bindVoter":
        fulfillment = await fulfillVoterBind(approval, args);
        break;
      case "approvalWorkflow.unbindVoter":
        fulfillment = await fulfillVoterUnbind(approval, args);
        break;
      case "orgs.create":
        fulfillment = await fulfillOrgCreate(approval, args);
        break;
      case "orgs.issueAdminCredential":
        fulfillment = await fulfillOrgIssueAdminCredential(approval, args);
        break;
      case "cardSetup.mintLink":
        fulfillment = await fulfillCardSetupLinkMint(approval);
        break;
      case "cardSetup.mintPortalLink":
        fulfillment = await fulfillPortalLinkMint(approval, args);
        break;
      case "employeeIdentity.upsert":
        fulfillment = await fulfillEmployeeIdentityUpsert(approval, args);
        break;
      case "employeeIdentity.bindMailbox":
        fulfillment = await fulfillEmployeeIdentityBindMailbox(approval, args);
        break;
      case "channels.remove":
      case "parties.remove":
        fulfillment = await fulfillDirectoryRemoveTicket(approval, args, tool);
        break;
      case "approvers.designatedAdmins.set":
        fulfillment = await fulfillDesignatedAdminsTicket(approval, args);
        break;
      case "members.promoteOwner":
        fulfillment = await fulfillPromoteOwnerTicket(approval, args);
        break;
      default:
        fulfillment = { ok: false, tool, at, error: "unknown_admin_tool" };
    }
    await persist(approval, fulfillment);
    // 木村 #255 second round: a settings-type tool succeeded → retry-cap reset
    // marker (flag + the Slack-only allow-list are checked inside, 木村 fourth
    // round 3; best effort, never changes the result).
    if (fulfillment.ok) {
      await recordSetupToolSucceeded({ orgId: approval.orgId, tool, source: "admin_fulfillment", approvalId: approval.id })
        .catch(() => undefined);
    }
    return fulfillment;
  } catch (error) {
    const message = error instanceof Error ? error.message : "fulfill_failed";
    const fulfillment: AdminFulfillment = { ok: false, tool, at, error: message };
    try {
      await persist(approval, fulfillment);
    } catch {
      approval.metadata = { ...approval.metadata, fulfillment };
    }
    return fulfillment;
  }
}

export { auditActionForAdminTool };

export async function fulfillApprovedAdmin(approval: ApprovalRequest): Promise<AdminFulfillment | null> {
  if (approval.status !== "approved" || !isAdminClassApproval(approval)) return null;
  try { return await executeApproval(approval, () => fulfillApprovedAdminCore(approval)); }
  catch (error) {
    return { ok: false, at: new Date().toISOString(), tool: approval.tool || "",
      error: error instanceof Error ? error.message : "approval_execution_failed" };
  }
}
