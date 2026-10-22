/**
 * Read-only per-tenant settings health (PR-1).
 * Never writes. Org comes from the caller credential only.
 * No secrets, tokens, fingerprints, or full email addresses.
 */
import { getOrgAdminAgent } from "@/lib/data/admin-agents";
import { listOrgParties } from "@/lib/data/directory";
import {
  readOrgInternalAudienceRule,
  type InternalAudienceRuleRead,
} from "@/lib/data/internal-audience-rule";
import { getEffectiveMailPolicy, type MailPolicySource } from "@/lib/data/mail-policy";
import { listNotificationChannels } from "@/lib/data/notification-channels";
import { getGatewayStatusForOrg } from "@/lib/data/org-context";
import { getEffectiveReplyPolicy, type ReplyPolicySource } from "@/lib/data/reply-policy";
import { getEffectiveSchedulingPolicy, type SchedulingPolicySource } from "@/lib/data/scheduling-policy";
import { checkSetupApproverBindingStatus } from "@/lib/approval-workflow/voter-binding";
import { isTenantSettingsHealthEnabledForOrg } from "@/lib/feature-flags";
import { isDefaultMailPolicy } from "@/lib/mail-policy/validate";
import type { AdminAgentStatus, GatewayLinkStatus, OrgMailPolicy } from "@/lib/types";

export type TenantSettingHealthStatus = "ok" | "missing" | "degraded" | "unavailable";
export type TenantSettingHealthEffect = "blocks" | "draft_only" | "silent_default";
export type TenantSettingsMailMode = "A" | "B" | "ok" | "unavailable";

export type TenantSettingHealthItem = {
  id:
    | "internal_domains"
    | "mail_policy"
    | "reply_policy"
    | "scheduling_policy"
    | "voter_bindings"
    | "notification_channels"
    | "gateway"
    | "admin_agent";
  status: TenantSettingHealthStatus;
  effect: TenantSettingHealthEffect;
  domains?: string[];
  domainCount?: number;
  partyDomainCount?: number;
  source?: MailPolicySource | ReplyPolicySource | SchedulingPolicySource;
  providers?: string[];
  enabledChannelCount?: number;
  gatewayStatus?: GatewayLinkStatus;
  adminAgentStatus?: AdminAgentStatus | "missing";
  activeVoterBindings?: number;
  pendingVoterBindings?: number;
};

export type TenantSettingsHealth = {
  ok: true;
  readOnly: true;
  orgId: string;
  mailMode: TenantSettingsMailMode;
  settings: TenantSettingHealthItem[];
  nextStepJa: string;
};

export type TenantSettingsHealthFailure = {
  ok: false;
  readOnly: true;
  code: "tenant_settings_health_unavailable" | "org_required";
};

export type EmployeeTenantSettingsHealth = {
  ok: true;
  readOnly: true;
  mailMode: TenantSettingsMailMode;
  nextStepJa: string;
};

export type TenantHealthStores = {
  getInternalAudienceRule: (orgId: string) => Promise<InternalAudienceRuleRead>;
  getEffectiveMailPolicy: (orgId: string) => Promise<{
    policy: OrgMailPolicy;
    source: MailPolicySource;
  }>;
  getEffectiveReplyPolicy: (orgId: string) => Promise<{ source: ReplyPolicySource }>;
  getEffectiveSchedulingPolicy: (orgId: string) => Promise<{ source: SchedulingPolicySource }>;
  listEmailDomainParties: (orgId: string) => Promise<Array<{ domain: string; audience: string }>>;
  listNotificationChannels: (orgId: string) => Promise<Array<{ provider: string; enabled: boolean }>>;
  listVoterBindings: (orgId: string) => Promise<{ activeCount: number; pendingCount: number }>;
  getGatewayStatus: (orgId: string) => Promise<GatewayLinkStatus>;
  getAdminAgentStatus: (orgId: string) => Promise<AdminAgentStatus | null>;
};

const EMAIL_LIKE = /@/;

function safeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (!domain || EMAIL_LIKE.test(domain)) return null;
  if (domain.includes("://") || domain.includes("/")) return null;
  return domain;
}

function uniqueDomains(values: string[]): string[] {
  return [...new Set(values.map(safeDomain).filter((d): d is string => Boolean(d)))].sort();
}

function hasInternalCoveringRule(policy: OrgMailPolicy): boolean {
  return policy.rules.some((rule) => rule.audience === "internal" || rule.audience === "any");
}

function policySourceStatus(source: "employee" | "org" | "default"): TenantSettingHealthStatus {
  return source === "default" ? "missing" : "ok";
}

function nextStepJa(mailMode: TenantSettingsMailMode, settings: TenantSettingHealthItem[]): string {
  if (mailMode === "unavailable") {
    return "テナント設定を読み取れませんでした。再試行するか、管理者に確認してください。欠落していないものとして扱わないでください。";
  }
  if (mailMode === "A") {
    return "社内メールドメインが未設定です。管理MCPの internalAudienceRule.patch と mailPolicy.patch を人が承認してください（B1 は emailDomains だけを見ます）。";
  }
  if (mailMode === "B") {
    return "社内ドメインはあるが内部送信ルールがありません。mailPolicy.patch で audience=internal の needs_approval を人が承認してください。";
  }
  const inbox = settings.find((s) => s.id === "notification_channels" && s.status !== "ok");
  const voters = settings.find((s) => s.id === "voter_bindings" && s.status !== "ok");
  if (inbox) {
    return "承認通知チャネルが未設定です。setup.lineApproval.upsert / setup.slackApprover.set で人が口を設定してください。";
  }
  if (voters) {
    return "承認者バインディングが未設定です。approvalWorkflow.bindVoter を人が承認してください。";
  }
  return "必須のテナント設定は揃っています。";
}

function employeeNextStepJa(mailMode: TenantSettingsMailMode): string {
  if (mailMode === "unavailable") {
    return "設定を確認できませんでした。管理者に確認してください。";
  }
  if (mailMode === "A") {
    return "社内メールは下書きになります。管理者に社内ドメインの設定を依頼してください。";
  }
  if (mailMode === "B") {
    return "社内送信のルールがありません。管理者に設定を依頼してください。";
  }
  return "テナント設定は揃っています。詳細は管理者に確認してください。";
}

export function toEmployeeTenantSettingsHealth(
  full: TenantSettingsHealth
): EmployeeTenantSettingsHealth {
  return {
    ok: true,
    readOnly: true,
    mailMode: full.mailMode,
    nextStepJa: employeeNextStepJa(full.mailMode),
  };
}

export const defaultTenantHealthStores: TenantHealthStores = {
  async getInternalAudienceRule(orgId) {
    return readOrgInternalAudienceRule(orgId);
  },
  async getEffectiveMailPolicy(orgId) {
    return getEffectiveMailPolicy(orgId);
  },
  async getEffectiveReplyPolicy(orgId) {
    return getEffectiveReplyPolicy(orgId);
  },
  async getEffectiveSchedulingPolicy(orgId) {
    return getEffectiveSchedulingPolicy(orgId);
  },
  async listEmailDomainParties(orgId) {
    const parties = await listOrgParties(orgId);
    return parties
      .filter((row) => row.kind === "email_domain")
      .map((row) => ({ domain: row.identifier, audience: row.audience }));
  },
  async listNotificationChannels(orgId) {
    const rows = await listNotificationChannels(orgId);
    return rows.map((row) => ({ provider: row.provider, enabled: row.enabled }));
  },
  async listVoterBindings(orgId) {
    const status = await checkSetupApproverBindingStatus(orgId);
    return { activeCount: status.activeCount, pendingCount: status.pendingCount };
  },
  async getGatewayStatus(orgId) {
    return getGatewayStatusForOrg(orgId);
  },
  async getAdminAgentStatus(orgId) {
    const agent = await getOrgAdminAgent(orgId);
    return agent?.status ?? null;
  },
};

async function readOrNull<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

function unavailable(id: TenantSettingHealthItem["id"]): TenantSettingHealthItem {
  return { id, status: "unavailable", effect: "blocks" };
}

export async function buildTenantSettingsHealth(
  orgId: string,
  stores: TenantHealthStores = defaultTenantHealthStores
): Promise<TenantSettingsHealth> {
  const iar = await readOrNull(() => stores.getInternalAudienceRule(orgId));
  const mail = await readOrNull(() => stores.getEffectiveMailPolicy(orgId));
  const reply = await readOrNull(() => stores.getEffectiveReplyPolicy(orgId));
  const scheduling = await readOrNull(() => stores.getEffectiveSchedulingPolicy(orgId));
  const parties = await readOrNull(() => stores.listEmailDomainParties(orgId));
  const channels = await readOrNull(() => stores.listNotificationChannels(orgId));
  const voters = await readOrNull(() => stores.listVoterBindings(orgId));
  const gateway = await readOrNull(() => stores.getGatewayStatus(orgId));
  const adminAgent = await readOrNull(() => stores.getAdminAgentStatus(orgId));

  const iarRule = iar.ok && iar.value.status === "ok" ? iar.value.rule : null;
  const iarUnavailable = !iar.ok || iar.value.status === "unavailable";
  const iarDomains = iarRule ? uniqueDomains(iarRule.emailDomains) : [];
  const partyDomains = parties.ok
    ? uniqueDomains(parties.value.map((row) => row.domain))
    : [];

  let internalDomains: TenantSettingHealthItem;
  if (iarUnavailable || !parties.ok) {
    internalDomains = unavailable("internal_domains");
  } else if (iarDomains.length > 0) {
    internalDomains = {
      id: "internal_domains",
      status: "ok",
      effect: "draft_only",
      domains: iarDomains,
      domainCount: iarDomains.length,
      partyDomainCount: partyDomains.length,
    };
  } else if (partyDomains.length > 0) {
    internalDomains = {
      id: "internal_domains",
      status: "degraded",
      effect: "draft_only",
      domains: [],
      domainCount: 0,
      partyDomainCount: partyDomains.length,
    };
  } else {
    internalDomains = {
      id: "internal_domains",
      status: "missing",
      effect: "draft_only",
      domains: [],
      domainCount: 0,
      partyDomainCount: 0,
    };
  }

  let mailPolicy: TenantSettingHealthItem;
  if (!mail.ok) {
    mailPolicy = unavailable("mail_policy");
  } else {
    const hasInternal = hasInternalCoveringRule(mail.value.policy);
    const isDefault = mail.value.source === "default" || isDefaultMailPolicy(mail.value.policy);
    let status: TenantSettingHealthStatus = "ok";
    if (!hasInternal) {
      status = isDefault && iarDomains.length === 0 ? "missing" : "degraded";
    }
    mailPolicy = {
      id: "mail_policy",
      status,
      effect: "draft_only",
      source: mail.value.source,
    };
  }

  const replyPolicy: TenantSettingHealthItem = reply.ok
    ? {
        id: "reply_policy",
        status: policySourceStatus(reply.value.source),
        effect: "silent_default",
        source: reply.value.source,
      }
    : unavailable("reply_policy");

  const schedulingPolicy: TenantSettingHealthItem = scheduling.ok
    ? {
        id: "scheduling_policy",
        status: policySourceStatus(scheduling.value.source),
        effect: "silent_default",
        source: scheduling.value.source,
      }
    : unavailable("scheduling_policy");

  let voterBindings: TenantSettingHealthItem;
  if (!voters.ok) {
    voterBindings = unavailable("voter_bindings");
  } else if (voters.value.activeCount > 0) {
    voterBindings = {
      id: "voter_bindings",
      status: "ok",
      effect: "blocks",
      activeVoterBindings: voters.value.activeCount,
      pendingVoterBindings: voters.value.pendingCount,
    };
  } else if (voters.value.pendingCount > 0) {
    voterBindings = {
      id: "voter_bindings",
      status: "degraded",
      effect: "blocks",
      activeVoterBindings: 0,
      pendingVoterBindings: voters.value.pendingCount,
    };
  } else {
    voterBindings = {
      id: "voter_bindings",
      status: "missing",
      effect: "blocks",
      activeVoterBindings: 0,
      pendingVoterBindings: 0,
    };
  }

  let notification: TenantSettingHealthItem;
  if (!channels.ok) {
    notification = unavailable("notification_channels");
  } else {
    const enabled = channels.value.filter((row) => row.enabled);
    const providers = [...new Set(enabled.map((row) => row.provider))].sort();
    let status: TenantSettingHealthStatus = "ok";
    if (enabled.length === 0) status = channels.value.length > 0 ? "degraded" : "missing";
    notification = {
      id: "notification_channels",
      status,
      effect: "blocks",
      providers,
      enabledChannelCount: enabled.length,
    };
  }

  let gatewayItem: TenantSettingHealthItem;
  if (!gateway.ok) {
    gatewayItem = unavailable("gateway");
  } else if (gateway.value === "linked") {
    gatewayItem = { id: "gateway", status: "ok", effect: "silent_default", gatewayStatus: gateway.value };
  } else if (gateway.value === "pending") {
    gatewayItem = { id: "gateway", status: "missing", effect: "silent_default", gatewayStatus: gateway.value };
  } else {
    gatewayItem = { id: "gateway", status: "degraded", effect: "blocks", gatewayStatus: gateway.value };
  }

  let adminItem: TenantSettingHealthItem;
  if (!adminAgent.ok) {
    adminItem = unavailable("admin_agent");
  } else if (adminAgent.value === "linked") {
    adminItem = { id: "admin_agent", status: "ok", effect: "blocks", adminAgentStatus: adminAgent.value };
  } else if (adminAgent.value === "needs_reauth" || adminAgent.value === "revoked") {
    adminItem = { id: "admin_agent", status: "degraded", effect: "blocks", adminAgentStatus: adminAgent.value };
  } else {
    adminItem = {
      id: "admin_agent",
      status: "missing",
      effect: "blocks",
      adminAgentStatus: adminAgent.value ?? "missing",
    };
  }

  const settings: TenantSettingHealthItem[] = [
    internalDomains,
    mailPolicy,
    replyPolicy,
    schedulingPolicy,
    voterBindings,
    notification,
    gatewayItem,
    adminItem,
  ];

  let mailMode: TenantSettingsMailMode = "ok";
  if (iarUnavailable || !mail.ok) mailMode = "unavailable";
  else if (iarDomains.length === 0) mailMode = "A";
  else if (!hasInternalCoveringRule(mail.value.policy)) mailMode = "B";

  return {
    ok: true,
    readOnly: true,
    orgId,
    mailMode,
    settings,
    nextStepJa: nextStepJa(mailMode, settings),
  };
}

export async function attachTenantSettingsHealth<T extends Record<string, unknown>>(
  orgId: string | null | undefined,
  payload: T,
  audience: "employee" | "admin" = "employee"
): Promise<
  T & {
    tenantSettingsHealth?:
      | TenantSettingsHealth
      | EmployeeTenantSettingsHealth
      | TenantSettingsHealthFailure;
  }
> {
  if (!isTenantSettingsHealthEnabledForOrg(orgId)) return payload;
  const id = String(orgId ?? "").trim();
  if (!id) return payload;
  try {
    const full = await buildTenantSettingsHealth(id);
    return {
      ...payload,
      tenantSettingsHealth:
        audience === "admin" ? full : toEmployeeTenantSettingsHealth(full),
    };
  } catch {
    if (audience === "employee") {
      return {
        ...payload,
        tenantSettingsHealth: {
          ok: true,
          readOnly: true,
          mailMode: "unavailable",
          nextStepJa: employeeNextStepJa("unavailable"),
        },
      };
    }
    return {
      ...payload,
      tenantSettingsHealth: { ok: false, readOnly: true, code: "tenant_settings_health_unavailable" },
    };
  }
}
