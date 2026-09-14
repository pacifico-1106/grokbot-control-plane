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
import { linkAgent } from "@/lib/data/bindings";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import {
  deleteSlackImEmployeeRoute,
  isSlackImChannelId,
  syncSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { normalizeApproverUserIds, parseApprovalChannelId } from "@/lib/employees/approval-inbox";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { defaultProjectAccess, normalizeProjectAccess } from "@/lib/employees/project-access";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import { defaultVoice, normalizeVoice } from "@/lib/employees/voice";
import { normalizeSpendLimits } from "@/lib/spend-gate";
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { ADMIN_AUDIT_CLASS, auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import type {
  ActionLimits,
  AllowedAccount,
  ApprovalPolicy,
  ApprovalRequest,
  ChannelClassification,
  ConversationSurface,
  EmployeeScope,
  OrgPartyKind,
  SpendLimits,
} from "@/lib/types";

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
};

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

  const updated = await updateEmployeePolicy({
    orgId: approval.orgId,
    employeeId,
    scopes: employee.scopes,
    allowedPurposes: employee.allowedPurposes,
    approvalPolicy: employee.approvalPolicy,
    approvalChannelId: parsed.id,
  });
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
  });
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: result.employee.id,
    credentialId: result.credentialId,
    action: "admin.hire",
    purpose: "admin.hire",
    summary: `${displayName} を人確認のうえで発行`,
    metadata: { auditClass: ADMIN_AUDIT_CLASS, approvalId: approval.id },
  });
  return {
    ok: true,
    tool: "employees.issue",
    at: new Date().toISOString(),
    employeeId: result.employee.id,
    secretPrefix: secret.prefix,
    oneTimeSecret: secret.raw,
    nextStepJa: TOOL_NEXTSTEP_JA["employees.issue"],
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
    nextStepJa: TOOL_NEXTSTEP_JA.link,
  };
}

async function fulfillPolicy(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const employeeId = String(args.employeeId || "").trim();
  const scopes = asScopes(args.scopes);
  const approvalPolicy = args.approvalPolicy as ApprovalPolicy;
  if (!employeeId || !scopes.length || !["auto", "risk_based", "always_human"].includes(approvalPolicy)) {
    throw new Error("invalid_policy_payload");
  }
  const updated = await updateEmployeePolicy({
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
  const identifier = String(args.identifier || "").trim();
  const kind = String(args.kind || "") as OrgPartyKind;
  if (!identifier) throw new Error("identifier_required");
  const party = await upsertOrgParty({
    orgId: approval.orgId,
    kind,
    identifier,
    audience: args.audience === "internal" ? "internal" : "external",
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
  return { ok: true, tool: "parties.upsert", at: new Date().toISOString(), partyId: party.id };
}

async function fulfillChannel(approval: ApprovalRequest, args: Record<string, unknown>): Promise<AdminFulfillment> {
  const externalId = String(args.externalId || args.identifier || "").trim();
  if (!externalId) throw new Error("external_id_required");
  const surface = String(args.surface || "slack") as ConversationSurface;
  const classification = String(args.classification || "unknown") as ChannelClassification;
  const employeeId = String(args.employeeId || "").trim();
  const slackTeamId = String(args.slackTeamId || "").trim();
  const isSlackIm = surface === "slack" && isSlackImChannelId(externalId);
  if (isSlackIm && employeeId && classification === "internal" && args.mixed !== true) {
    const employee = await getEmployee(employeeId, approval.orgId);
    if (!employee) throw new Error("employee_not_found");
    if (employee.status !== "active") throw new Error("employee_not_active");
  }
  // Removing first makes an omitted employee fail closed even if a later
  // classification write fails. A new route is installed only after success.
  if (isSlackIm && (!employeeId || classification !== "internal" || args.mixed === true)) {
    await deleteSlackImEmployeeRoute({ orgId: approval.orgId, slackChannelId: externalId });
  }
  const channel = await upsertOrgChannel({
    orgId: approval.orgId,
    surface,
    externalId,
    classification,
    mixed: args.mixed === true,
  });
  const route = isSlackIm
    ? await syncSlackImEmployeeRoute({
        orgId: approval.orgId,
        surface,
        slackChannelId: externalId,
        slackTeamId,
        classification: channel.classification,
        mixed: channel.mixed,
        employeeId,
      })
    : null;
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
    employeeId: route?.employeeId,
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

export async function fulfillApprovedAdmin(
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
      case "setup.slackAdapter.setBotToken":
        fulfillment = await fulfillSlackAdapterSetBotToken(approval, args);
        break;
      case "setup.lineApproval.upsert":
        fulfillment = await fulfillLineApprovalUpsert(approval, args);
        break;
      case "setup.lineApproval.setEmployeeInbox":
        fulfillment = await fulfillLineApprovalSetEmployeeInbox(approval, args);
        break;
      case "setup.lineApproval.demoteTelegram":
        fulfillment = await fulfillLineApprovalDemoteTelegram(approval, args);
        break;
      default:
        fulfillment = { ok: false, tool, at, error: "unknown_admin_tool" };
    }
    await persist(approval, fulfillment);
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
