/** Domain types for AI社員 control plane (Grok Bot) */

export type IntegrationMode = "managed" | "byo";

export type GatewayLinkStatus = "linked" | "pending" | "disconnected";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "revision_requested";

export type ApprovalPolicy = "auto" | "always_human" | "risk_based";

export type RiskDomain =
  | "comm_external"
  | "money"
  | "destructive"
  | "commit"
  | "browser"
  | "safe";

export type SodLevel = "ok" | "warn" | "force_human";

export type SodVerdict =
  | { level: "ok"; domains: RiskDomain[] }
  | { level: "warn"; domains: RiskDomain[]; reason: string }
  | { level: "force_human"; domains: RiskDomain[]; reason: string };

export type ActionLimit = { perDay?: number; perMonth?: number };
export type ActionLimits = Record<string, ActionLimit>;

export type NotificationProvider = "telegram" | "line" | "slack";
/**
 * Slack notify lives on org_notification_channels (approval inbox).
 * Conversation posting lives on org_conversation_adapters (comm.send / slack.post)
 * after egress. Do not mix the two planes at runtime.
 */


export interface NotificationChannel {
  id: string;
  orgId: string;
  provider: NotificationProvider;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  webhookRef: string;
  hasCredentials: boolean;
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

/** Live conversation posting adapter (separate from notification inbox). */
export interface ConversationAdapter {
  id: string;
  orgId: string;
  surface: ConversationSurface;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Per-employee purchase limits (JPY). Fail-closed when order scope present but limits missing. */
export interface SpendLimits {
  /** 0 = 発注禁止（自動不可）。未設定扱いは evaluateSpend 側で needs_approval。 */
  maxPerOrderJpy: number;
  maxPerDayJpy?: number | null;
  maxPerMonthJpy?: number | null;
  /** Free-text tip e.g. "eSIMのみ" / merchant allow hint */
  merchantAllowTip?: string | null;
  /** 初回発注は必ず人間承認（default true） */
  firstOrderRequiresHuman?: boolean;
}

export interface CommerceAuthorizationInput {
  targetSystem: "sealith";
  currency: "JPYC";
  maxAmount: string;
  merchantPolicy: {
    allowedMerchantIds: string[];
    requiredSellerOfRecord: string;
  };
  skuPolicy?: { allowedSkuIds: string[] };
  quoteHash?: string;
  validUntil: string;
}

/** External account the AI employee may use (browser / SNS / SaaS). Flexible — not Google-only. */
export interface AllowedAccount {
  /** Free text OR preset key (google, microsoft365, line, x, instagram, facebook, slack, custom, …). */
  service: string;
  /** Email, @handle, page id, etc. */
  accountId: string;
  label?: string;
  /** Hint that browser session must match this identity. */
  browserRequired?: boolean;
}

export type OrgMemberRole = "owner" | "admin" | "member";

/** JP SME job role presets for human team members (not AI employees). */
export type HumanJobRole =
  | "owner"
  | "sales"
  | "accounting"
  | "admin_affairs"
  | "legal"
  | "ops_ai"
  | "custom";

/** Fine-grained human capabilities (beyond coarse owner/admin). */
export type HumanCapability =
  | "view_dashboard"
  | "view_employees"
  | "view_audit"
  | "approve_actions"
  | "manage_spend_limits"
  | "hire_issue_credentials"
  | "manage_team"
  | "manage_billing";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid";

/** Grok Bot–oriented scopes (not Sealith transfer scopes). */
export type EmployeeScope =
  | "tools:read"
  | "tools:invoke"
  | "calendar:read"
  | "mail:draft"
  | "mail:send"
  | "agentmail:draft"
  | "agentmail:send"
  | "calendar:propose"
  | "calendar:confirm"
  | "files:read"
  | "files:write"
  | "browser:use"
  | "commerce:quote"
  | "commerce:order"
  | "slack:post"
  | "slack:post_external"
  | "drive:share_external"
  | "knowledge:search"
  | "audit:append"
  | "approvals:request";

/**
 * Email channel layers — never mix (Ando §2 / Kimura P0).
 * - human_gmail: 人間の Workspace / Gmail（原則エージェント直操作しない）
 * - agentmail: AI社員専用 inbox（P0.5 スキーマ/ポリシー予約・本送信は P1）
 * - staffpass_resend: 制御面システム通知（歓迎・承認依頼・トライアル）
 */
export type EmailLayer = "human_gmail" | "agentmail" | "staffpass_resend";

/** Conversation surface for channel-agnostic egress (WHO × WHAT). */
export type ConversationSurface = "slack" | "line" | "mail" | "phone" | "web";

/**
 * Destination of an outbound conversation. Ingress audience is independent.
 * Unknown / missing destination → treat as external (fail-closed).
 */
export interface ConversationContext {
  surface: ConversationSurface;
  orgId: string;
  threadId?: string;
  email?: string;
  slackChannelId?: string;
  slackUserId?: string;
  phone?: string;
  lineId?: string;
}

export type Audience = "internal" | "external" | "unknown";
export type InformationClass = "public" | "internal" | "confidential" | "verbatim";
export type DisclosureFidelity = "summary" | "source";
export type EgressDecision = "allow" | "summarize" | "needs_approval" | "deny";

export type OrgPartyKind =
  | "email_domain"
  | "slack_channel"
  | "slack_user"
  | "phone"
  | "line"
  | "mail_address";

export interface OrgParty {
  id: string;
  orgId: string;
  kind: OrgPartyKind;
  identifier: string;
  audience: Exclude<Audience, "unknown">;
  createdAt: string;
  updatedAt: string;
}

export type ChannelClassification = "internal" | "shared_external" | "unknown";

export interface OrgChannel {
  id: string;
  orgId: string;
  surface: ConversationSurface;
  externalId: string;
  classification: ChannelClassification;
  mixed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProjectAccessMode = "company" | "selected" | "all";

export interface EmployeeProjectAccess {
  mode: ProjectAccessMode;
  projectIds: string[];
}

export interface OrgProject {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InformationAsset {
  id: string;
  orgId: string;
  ref: string;
  class: InformationClass;
  /** Null / omitted → org default 会社全般 project. */
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EgressVerdict {
  decision: EgressDecision;
  audience: Audience;
  effectiveAudience: "internal" | "external";
  informationClass: InformationClass;
  fidelity: DisclosureFidelity;
  namedRecipients: boolean;
  reason: string;
  messageJa: string;
}


/** Employee badge character / register (HOW). Audience sets a polite floor. */
export type VoiceTemplate = "polite" | "frank" | "custom";
export type VoiceRegister = "polite" | "frank";
export type VoiceEndings = "desumasu" | "da-dearu" | "either";

export interface EmployeeVoice {
  template: VoiceTemplate;
  register: VoiceRegister;
  endings: VoiceEndings;
  forbidden: string[];
  signOff: string | null;
  externalFloor: "polite";
}

export interface EffectiveVoice extends EmployeeVoice {
  floorApplied: boolean;
}


/** P0.5 reservation only — no live AgentMail SDK wiring in P0. */
export interface AgentMailReservation {
  employeeId: string;
  orgId: string;
  /** Future inbox id from AgentMail provider */
  inboxId: string | null;
  status: "reserved" | "provisioning" | "active" | "disabled";
  layer: "agentmail";
}

/** Gateway invoke body (fail-closed contract). */
export interface GatewayInvokeRequest {
  employeeId?: string;
  tool: string;
  /** Required — job purpose key (must be in credential.allowedPurposes when set). */
  purpose: string;
  /** Required — correlation id (camelCase or job_id). */
  jobId?: string;
  job_id?: string;
  amountJpy?: number;
  /** Optional Sealith correlation; absence keeps Staffpass fully standalone. */
  commerceAuthorization?: CommerceAuthorizationInput;
  isFirstOrder?: boolean;
  spentTodayJpy?: number;
  spentThisMonthJpy?: number;
  /** Optional claimed browser/SNS identity for allowedAccounts check (C5). */
  claimedAccount?: { service?: string; accountId?: string };
  service?: string;
  accountId?: string;
  args?: Record<string, unknown>;
  /**
   * Prior human approval id. When status=approved for this employee,
   * confirm/send/order may complete (and meter). Approval button alone is not billed.
   */
  approvalId?: string;
  /** Revision parent returned by a prior revision_requested decision. */
  parentApprovalId?: string;
  /**
   * Optional conversation context for audience × information-class egress.
   * Old clients may omit it; slack/comm without destination fail-closed as external.
   */
  conversation?: Partial<ConversationContext>;
  surface?: ConversationSurface;
  threadId?: string;
  email?: string;
  slackChannelId?: string;
  slackUserId?: string;
  phone?: string;
  lineId?: string;
  informationClass?: InformationClass;
  disclosure?: DisclosureFidelity;
}

export type AuditAction =
  | "credential.issued"
  | "credential.revoked"
  | "tool.invoke"
  | "approval.requested"
  | "approval.resolved"
  | "approval.revision_requested"
  | "approval.telegram_error"
  | "notification.channel_updated"
  | "notification.test_sent"
  | "notification.delivery_failed"
  | "conversation.adapter_updated"
  | "slack.post_failed"
  | "employee.sod_forced"
  | "employee.sod_override"
  | "action_limit.reached"
  | "action_limit.denied"
  | "billing.updated"
  | "email.sent"
  | "gateway.link_changed"
  | "employee.created"
  | "employee.updated"
  | "employee.terminated"
  | "member.invited"
  | "commerce.projection_received"
  | "authority.event_delivery";

export interface Org {
  id: string;
  name: string;
  integrationMode: IntegrationMode;
  gatewayStatus: GatewayLinkStatus;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  /** Coarse org seat (legacy Stripe/Auth mapping). */
  role: OrgMemberRole;
  /** SME 職務プリセット（営業・経理など）。 */
  jobRole?: HumanJobRole;
  /** jobRole=custom のときの自由ラベル。 */
  jobLabel?: string | null;
  /** 権限フラグ（職務パックから編集可）。 */
  capabilities?: HumanCapability[];
  status: "active" | "invited" | "disabled";
}

/** Product alias — human team member with job role + capability flags. */
export type HumanMember = OrgMember;

export interface Employee {
  id: string;
  orgId: string;
  displayName: string;
  roleLabel: string;
  jobDescription: string;
  status: "active" | "suspended" | "draft";
  scopes: EmployeeScope[];
  allowedPurposes: string[];
  approvalPolicy: ApprovalPolicy;
  sodLevel: SodLevel;
  actionLimits: ActionLimits;
  /** Purchase budget / risk limits (optional until commerce:order). */
  spend?: SpendLimits | null;
  /** External accounts engraved on the employee badge (shared-PC safe IDs). */
  allowedAccounts?: AllowedAccount[];
  /**
   * Optional machine-readable notify target (future AgentMail / bot inbox).
   * On approve/reject, Staffpass may POST/email status here in addition to org Resend.
   */
  approvalNotifyEmail?: string | null;
  /** Optional webhook; best-effort POST JSON on resolve (never fails the resolve). */
  callbackUrl?: string | null;
  /** Default Routine text forcing status-poll wait (hire-time / one-time display). */
  approvalRoutineText?: string | null;
  /** Human manager (org_members.id, same org). Attached to egress approval tickets. */
  managerId?: string | null;
  /**
   * Badge character / register. Default polite. External audience cannot
   * drop below polite (see effectiveVoice).
   */
  voice: EmployeeVoice;
  /**
   * Project knowledge wall (WHICH). Default company = 会社全般 only.
   */
  projectAccess: EmployeeProjectAccess;
  credentialId: string | null;
  createdAt: string;
}

export interface Credential {
  id: string;
  orgId: string;
  employeeId: string;
  scopes: EmployeeScope[];
  allowedPurposes: string[];
  approvalPolicy: ApprovalPolicy;
  actionLimits: ActionLimits;
  spend?: SpendLimits | null;
  allowedAccounts?: AllowedAccount[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  orgId: string;
  employeeId: string;
  credentialId: string;
  /** Short ticket title for UI / email subject. */
  title: string;
  purpose: string;
  /** Rich multi-line summary (tool / purpose / job / risk / amount). */
  summary: string;
  risk: "low" | "medium" | "high";
  status: ApprovalStatus;
  /** Gateway tool id that triggered the ticket (e.g. mail.send). */
  tool?: string | null;
  /** Correlation job id from invoke. */
  jobId?: string | null;
  /** Human correction instructions when status=revision_requested. */
  revisionNote: string | null;
  /** Number of revision rounds inherited by resubmissions. */
  revisionCount: number;
  /** Prior approval that requested this resubmission. */
  parentApprovalId: string | null;
  /** Random, non-guessable Telegram callback reference. */
  telegramRef: string | null;
  /** Telegram message linked to this approval. */
  telegramMessageId: number | null;
  /** Extensible transport metadata (artifact_url, awaiting revision actor, etc.). */
  metadata: Record<string, unknown>;
  /**
   * Opaque token for signed status poll URL.
   * Present on create so Bot can persist; status API requires id+token.
   * Demo may keep plaintext; prod may store hash-only (token returned once).
   */
  statusToken: string;
  /** Relative poll path, e.g. /api/approvals/status?id=…&token=… */
  pollPath: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  employeeId: string | null;
  credentialId: string | null;
  action: AuditAction;
  purpose: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Subscription {
  id: string;
  orgId: string;
  planKey: "starter" | "business" | "managed";
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

export interface BillingPlan {
  id: "starter" | "business" | "managed";
  nameJa: string;
  trialDays: number;
  paymentMethods: Array<"card" | "customer_balance">;
  /** Placeholder monthly gated confirm quota (仮枠). */
  confirmQuotaPerMonth?: number;
}

/** Ando BM P0 — only Gateway confirm-class successes are billable. */
export type MeterEventType = "gated_confirm_action";

export interface GatedConfirmMeterPayload {
  type: "gated_confirm_action";
  orgId: string;
  employeeId: string;
  tool: string;
  jobId: string;
  billable: boolean;
}

export interface EmployeePolicyDraft {
  policy: {
    displayName: string;
    roleLabel: string;
    scopes: EmployeeScope[];
    allowedPurposes: string[];
    approvalPolicy: ApprovalPolicy;
    actionLimits: ActionLimits;
    expiresInDays: number;
    spend?: SpendLimits | null;
    /** Soft recommendation shown in hire step 3 (not forced). */
    spendRecommendation?: string | null;
    /** Suggested / configured external accounts (Google, SNS, etc.). */
    allowedAccounts?: AllowedAccount[];
    /** Optional 上長 (org member id). */
    managerId?: string | null;
    /** Optional badge voice (default polite on hire if omitted). */
    voice?: EmployeeVoice;
    /** Optional project wall (default company = 会社全般). */
    projectAccess?: EmployeeProjectAccess;
    /**
     * Per-tool approval hints from JP SME strict presets (Ando §3).
     * Distinct from human RBAC (OrgMember.capabilities).
     */
    toolApprovalDefaults?: Record<string, ApprovalPolicy | "deny">;
  };
  sodVerdict: SodVerdict;
  assumptions: string[];
  missingFields: Array<"role" | "purpose" | "risk" | "scope">;
  warnings: Array<
    | "broad_purpose_access"
    | "mail_send_requested"
    | "calendar_confirm_requested"
    | "commerce_order_requested"
    | "browser_use_requested"
    | "always_human_recommended"
  >;
  confidence: number;
  source: "rules";
}

/** Durable Grok Bot ↔ AI-employee binding status (persisted; not session). */
export type BindingStatus =
  | "unlinked"
  | "linked"
  | "degraded"
  | "needs_reauth"
  | "revoked";

/**
 * Lifeline binding: employeeId is stable forever.
 * Token reissue bumps credentialGeneration only — never resets employeeId.
 */
export interface EmployeeBinding {
  employeeId: string;
  orgId: string;
  grokBotAgentId: string | null;
  grokBotWorkspaceId: string | null;
  credentialGeneration: number;
  /** sha256 stub fingerprint of current credential material (never raw secret). */
  credentialFingerprint: string | null;
  status: BindingStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutableDenyCode =
  | "unbound"
  | "revoked"
  | "needs_reauth"
  | "degraded"
  | "health_failed"
  | "not_found";

export interface ExecutableDeny {
  ok: false;
  code: ExecutableDenyCode;
  message: string;
}

export interface ExecutableAllow {
  ok: true;
  binding: EmployeeBinding;
}
