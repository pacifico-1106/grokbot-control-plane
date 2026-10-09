/**
 * PR-D: approver authority — the ONE place that says which changes need
 * "オーナーまたは指定管理者" (standard) and which also need the owner
 * (sensitive). Classification looks at the tool AND the content of the change
 * (which keys / which approval kinds); anything unclear goes to the owner.
 *
 * PR-K / PR-L: add new tools to APPROVER_AUTHORITY_TARGETS (append only) and,
 * when the decision depends on content, a content rule in classifyApproverRequirement.
 */
import { PRIVILEGED_CAPABILITIES } from "@/lib/team/member-change-guard";
import { SCOPE_DOMAINS } from "@/lib/gateway/domains";
import type { EmployeeScope } from "@/lib/types";
import { normalizeActionLimits } from "@/lib/action-gate";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";

/** Stored on approval_requests.required_approver_kind. */
export type RequiredApproverKind = "owner_or_designated_admin" | "owner";

export const REQUIRED_APPROVER_KINDS: readonly RequiredApproverKind[] = [
  "owner_or_designated_admin",
  "owner",
];

export const DESIGNATED_ADMINS_GET_TOOL = "approvers.designatedAdmins.get";
export const DESIGNATED_ADMINS_SET_TOOL = "approvers.designatedAdmins.set";
/** オーナー追加 (existing active member → owner). Owner approval only; never with an invite. */
export const PROMOTE_OWNER_TOOL = "members.promoteOwner";

/**
 * All approver-authority targets. Append only (parallel PRs add rows).
 *
 * - standardTools: owner or designated admin. Content rules (contentRules) may
 *   escalate a standard tool to "owner".
 * - sensitiveTools: owner always.
 * - moneyApprovalKinds: approvalRoutes kinds whose route change is sensitive
 *   (billing / payment / contract tools map to "other"; 決裁 = "decision").
 * - nonMoneyApprovalKinds: approvalRoutes kinds that stay standard. Any kind in
 *   neither list → owner.
 * - sensitiveApprovalRoutesKeys: any change → owner (topicGate = センシティブ話題,
 *   decisionWorkflow = 決裁の金額しきい値 / tiers / deputy).
 * - moneyScopes: adding/removing one on policy.patch → owner; holding one makes
 *   approvalPolicy / toolApprovalDefaults changes owner-only, and makes
 *   employees.reinstate owner-only (PR-K).
 * - nonMoneyToolKeys: toolApprovalDefaults / actionLimits keys that stay
 *   standard. Any other key (commerce.order, billing / payment tools, unknown)
 *   → owner ("お金の人間承認を弱める変更").
 * - policyPatchKnownKeys: policy.patch args we understand; any other key → owner.
 * - strongCapabilities: any mention in the change → owner (MCP still rejects
 *   granting them; this is defence in depth).
 */
export const APPROVER_AUTHORITY_TARGETS = {
  standardTools: [
    "setup.slackApprover.set",
    "setup.lineApproval.upsert",
    "setup.lineApproval.setEmployeeInbox",
    "approvalWorkflow.patch",
    "approvalWorkflow.bindVoter",
    "approvalWorkflow.unbindVoter",
    "approvalRoutes.patch",
    "policy.patch",
    "employees.allowedAccounts.add",
    "employees.allowedAccounts.remove",
    // Future tools (PR-K / PR-L). Listed now so they can never ship untargeted.
    "members.update",
    "employees.leave",
    "employees.reinstate",
    // 2026-10-09 gap closure: these change approvers / permissions too.
    "setup.approvalDelivery.autoResolve",
    "setup.lineApproval.demoteTelegram",
    "employees.issue",
    // 2026-10-09 review item 3: who sees / who we talk to / under which name.
    "internalAudienceRule.patch",
    "parties.upsert",
    "channels.classify",
    "employees.postingIdentity.set",
    "mailPolicy.patch",
    // 木村 2026-10-09 22:48 (#279 decision 2): reply / scheduling / ingress
    // policy, conversation Bot token, AI-employee identity, org metadata, stuck
    // watch. Standard; money content (schedulingPolicy costCapJpy) → owner.
    // orgs.patch is platform-ops only and runs without a ticket today, so its
    // row only takes effect if it is ever filed as a ticket.
    "replyPolicy.patch",
    "schedulingPolicy.patch",
    "ingressHandoff.patch",
    "setup.slackAdapter.setBotToken",
    "employeeIdentity.upsert",
    "employeeIdentity.bindMailbox",
    "orgs.patch",
    "stuckWatch.patch",
  ],
  sensitiveTools: [
    "employees.spend.set",
    "plan.upgrade",
    "cardSetup.mintLink",
    "cardSetup.mintPortalLink",
    "decision.deputyActivate",
    "members.invite",
    DESIGNATED_ADMINS_SET_TOOL,
    PROMOTE_OWNER_TOOL,
  ],
  moneyApprovalKinds: ["decision", "other"],
  nonMoneyApprovalKinds: ["post", "mail", "account"],
  sensitiveApprovalRoutesKeys: ["topicGate", "decisionWorkflow"],
  moneyScopes: (Object.keys(SCOPE_DOMAINS) as EmployeeScope[]).filter(
    (scope) => SCOPE_DOMAINS[scope] === "money"
  ),
  nonMoneyToolKeys: [
    "mail.send",
    "mail.draft",
    "agentmail.send",
    "agentmail.draft",
    "calendar.propose",
    "calendar.confirm",
    "files.read",
    "files.write",
    "drive.share_external",
    "browser.use",
    "sns.publish",
    "slack.post",
    "slack.post_external",
    "knowledge.search",
    "commerce.quote",
  ],
  policyPatchKnownKeys: [
    "employeeId",
    "scopes",
    "allowedPurposes",
    "approvalPolicy",
    "actionLimits",
    "toolApprovalDefaults",
    "sodOverrideAcknowledged",
    "jobId",
    "approvalId",
  ],
  strongCapabilities: [...PRIVILEGED_CAPABILITIES],
} as const;

export type ApproverRequirementReason =
  | "standard_target_tool"
  | "sensitive_target_tool"
  | "strong_capability"
  | "money_route_kind"
  | "unknown_route_kind"
  | "topic_gate_or_decision_workflow"
  | "route_snapshot_unavailable"
  | "route_override_cleared"
  | "money_scope_change"
  | "money_scope_unverified"
  | "money_approval_weakened"
  | "money_tool_limits"
  | "unknown_policy_key"
  | "employee_has_money_scope"
  | "classification_failed"
  | "money_spend_limit"
  | "money_cost_cap"
  | "money_cost_cap_unverified"
  | "money_limits_unverified";

export interface ApproverRequirement {
  kind: RequiredApproverKind;
  reasons: ApproverRequirementReason[];
}

/**
 * Approvals needed (distinct verified owner / designated-admin approvers).
 * 確定仕様: standard 1 for every kind today, no settings screen or tool. The
 * extension point for a later "required count per approval type" is
 * requiredApprovalCount(); the value is recorded on the ticket at filing
 * (approver_authority.requiredApprovals) and fulfil refuses any ticket whose
 * recorded count the approval flow does not implement (> 1) — fail closed.
 */
export const REQUIRED_APPROVALS_DEFAULT = 1;
export const REQUIRED_APPROVALS_BY_KIND: Readonly<Record<RequiredApproverKind, number>> = Object.freeze({
  owner_or_designated_admin: REQUIRED_APPROVALS_DEFAULT,
  owner: REQUIRED_APPROVALS_DEFAULT,
});
export const MAX_IMPLEMENTED_REQUIRED_APPROVALS = 1;

export function requiredApprovalCount(input: { kind: RequiredApproverKind; tool?: string | null }): number {
  void input.tool; // per-approval-type overrides plug in here later
  return REQUIRED_APPROVALS_BY_KIND[input.kind] ?? REQUIRED_APPROVALS_DEFAULT;
}

/** Optional server-loaded state used to judge "what actually changes". */
export interface ApproverClassificationContext {
  /** Current scopes of the target employee (policy.patch / employees.reinstate). */
  currentEmployeeScopes?: readonly string[] | null;
  currentEmployeeApprovalPolicy?: string | null;
  /**
   * policy.patch (木村 2026-10-09 23:58, Problem A): the employee's stored
   * actionLimits / toolApprovalDefaults (raw; normalized here exactly like the
   * save path). Missing → money limits cannot be judged → owner.
   */
  currentEmployeeActionLimits?: Record<string, unknown> | null;
  currentEmployeeToolApprovalDefaults?: Record<string, unknown> | null;
  /**
   * schedulingPolicy.patch: schedulingRulesState() of the policy in force now
   * (`current`) and of what clearOverride would inherit (`ifCleared`).
   * Missing → the cost-cap change cannot be judged → owner.
   */
  schedulingRules?: { current: SchedulingRulesState; ifCleared: SchedulingRulesState } | null;
}

export interface ApproverClassificationInput {
  tool: string | null | undefined;
  /** Server-built ticket metadata (adminMutation, web artifact). Never agent-trusted for downgrades. */
  metadata?: Record<string, unknown> | null;
  context?: ApproverClassificationContext | null;
}

const STANDARD = new Set<string>(APPROVER_AUTHORITY_TARGETS.standardTools);
const SENSITIVE = new Set<string>(APPROVER_AUTHORITY_TARGETS.sensitiveTools);

export function isApproverAuthorityTargetTool(tool: string | null | undefined): boolean {
  const name = (tool || "").trim();
  return STANDARD.has(name) || SENSITIVE.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mentionsStrongCapability(value: unknown, depth = 0): boolean {
  if (depth > 12) return true; // too deep to judge → owner
  if (typeof value === "string") {
    return (APPROVER_AUTHORITY_TARGETS.strongCapabilities as readonly string[]).includes(value.trim());
  }
  if (Array.isArray(value)) return value.some((item) => mentionsStrongCapability(item, depth + 1));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) =>
        (APPROVER_AUTHORITY_TARGETS.strongCapabilities as readonly string[]).includes(key) ||
        mentionsStrongCapability(item, depth + 1)
    );
  }
  return false;
}

/** Canonical JSON (sorted keys) for before/after comparison. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function routesByKind(policy: Record<string, unknown> | null): Map<string, string> {
  const map = new Map<string, string>();
  const routes = policy && Array.isArray(policy.routes) ? policy.routes : [];
  for (const route of routes) {
    const kind = isRecord(route) && typeof route.kind === "string" ? route.kind : "__invalid__";
    map.set(kind, `${map.get(kind) ?? ""}${canonical(route)}`);
  }
  return map;
}

/** Read {before, after} for approvalRoutes.patch from MCP (__metadata) or web (artifact). */
function approvalRoutesSnapshots(
  metadata: Record<string, unknown>
): { before: Record<string, unknown> | null; after: Record<string, unknown> } | null {
  const mutation = isRecord(metadata.adminMutation) ? metadata.adminMutation : null;
  const meta = mutation && isRecord(mutation.__metadata) ? mutation.__metadata : null;
  if (meta && "afterSnapshot" in meta) {
    const after = isRecord(meta.afterSnapshot) ? meta.afterSnapshot : null;
    if (!after) return null;
    return { before: isRecord(meta.beforeSnapshot) ? meta.beforeSnapshot : null, after };
  }
  if (typeof metadata.artifact === "string") {
    try {
      const parsed = JSON.parse(metadata.artifact) as unknown;
      if (isRecord(parsed) && isRecord(parsed.after)) {
        return { before: isRecord(parsed.before) ? parsed.before : null, after: parsed.after };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function classifyApprovalRoutes(metadata: Record<string, unknown>, reasons: Set<ApproverRequirementReason>) {
  const mutation = isRecord(metadata.adminMutation) ? metadata.adminMutation : null;
  if (mutation?.clearOverride === true) {
    reasons.add("route_override_cleared");
    return;
  }
  const snapshots = approvalRoutesSnapshots(metadata);
  if (!snapshots) {
    reasons.add("route_snapshot_unavailable");
    return;
  }
  const before = routesByKind(snapshots.before);
  const after = routesByKind(snapshots.after);
  const money = new Set<string>(APPROVER_AUTHORITY_TARGETS.moneyApprovalKinds);
  const nonMoney = new Set<string>(APPROVER_AUTHORITY_TARGETS.nonMoneyApprovalKinds);
  for (const kind of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(kind) === after.get(kind)) continue;
    if (money.has(kind)) reasons.add("money_route_kind");
    else if (!nonMoney.has(kind)) reasons.add("unknown_route_kind");
  }
  for (const key of APPROVER_AUTHORITY_TARGETS.sensitiveApprovalRoutesKeys) {
    if (canonical(snapshots.before?.[key]) !== canonical(snapshots.after[key])) {
      reasons.add("topic_gate_or_decision_workflow");
    }
  }
}

function isNonMoneyToolKey(key: string): boolean {
  return (APPROVER_AUTHORITY_TARGETS.nonMoneyToolKeys as readonly string[]).includes(key);
}

function hasMoneyScope(scopes: readonly unknown[]): boolean {
  return scopes.some((scope) =>
    (APPROVER_AUTHORITY_TARGETS.moneyScopes as readonly string[]).includes(String(scope))
  );
}

function classifyPolicyPatch(
  args: Record<string, unknown>,
  context: ApproverClassificationContext | null | undefined,
  reasons: Set<ApproverRequirementReason>
) {
  for (const key of Object.keys(args)) {
    if (!(APPROVER_AUTHORITY_TARGETS.policyPatchKnownKeys as readonly string[]).includes(key)) {
      reasons.add("unknown_policy_key");
    }
  }
  const nextScopes = Array.isArray(args.scopes) ? args.scopes : null;
  const currentScopes = context?.currentEmployeeScopes ?? null;
  const nextHasMoney = nextScopes ? hasMoneyScope(nextScopes) : false;
  const currentHasMoney = currentScopes ? hasMoneyScope(currentScopes) : null;
  if (args.scopes !== undefined && !nextScopes) reasons.add("unknown_policy_key");
  if (currentHasMoney === null) {
    // Cannot see the current scopes: a money scope in the request may be an addition.
    if (nextHasMoney) reasons.add("money_scope_unverified");
  } else if (nextScopes) {
    const moneyScopes = APPROVER_AUTHORITY_TARGETS.moneyScopes as readonly string[];
    const changed = moneyScopes.some(
      (scope) => nextScopes.map(String).includes(scope) !== currentScopes!.map(String).includes(scope)
    );
    if (changed) reasons.add("money_scope_change");
  }
  const holdsMoney = nextHasMoney || currentHasMoney === true;
  if (holdsMoney) {
    const policy = typeof args.approvalPolicy === "string" ? args.approvalPolicy : null;
    const current = context?.currentEmployeeApprovalPolicy ?? null;
    if (policy !== null && policy !== "always_human" && policy !== current) {
      reasons.add("money_approval_weakened");
    }
  }
  classifyPolicyMoneyLimits(args, context, reasons);
}

/** Money keys whose normalized value differs between current and next (union of keys). */
function changedMoneyKeys(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  return [...keys].filter((key) => !isNonMoneyToolKey(key) && canonical(current[key]) !== canonical(next[key]));
}

/**
 * 木村 2026-10-09 23:58 (Problem A). Compare what is stored now with what the
 * save path (fulfillPolicy → updateEmployeePolicy) would write:
 * - actionLimits, when sent (incl. {} / null), REPLACES the map with
 *   normalizeActionLimits(args.actionLimits) → a stored money cap it drops or
 *   changes counts as changed. Left out (undefined) = the current value is
 *   kept (2026-10-10: fulfillPolicy passes it explicitly, whatever
 *   updateEmployeePolicy does with undefined) → not a change.
 * - toolApprovalDefaults, when sent, REPLACES the map with
 *   normalizeToolApprovalDefaults(args.toolApprovalDefaults); left out = kept.
 *   The current map is normalized the same way, plus any stored key the
 *   normalizer would drop (dropping it on save is a change too).
 * Any money key (anything not in nonMoneyToolKeys) that changes → owner.
 * Current values unreadable → owner (money_limits_unverified).
 */
function classifyPolicyMoneyLimits(
  args: Record<string, unknown>,
  context: ApproverClassificationContext | null | undefined,
  reasons: Set<ApproverRequirementReason>
) {
  if (args.actionLimits !== undefined && args.actionLimits !== null && !isRecord(args.actionLimits)) reasons.add("money_tool_limits");
  if (args.toolApprovalDefaults !== undefined && !isRecord(args.toolApprovalDefaults)) reasons.add("money_approval_weakened");
  const rawLimits = context?.currentEmployeeActionLimits;
  const rawDefaults = context?.currentEmployeeToolApprovalDefaults;
  if (!isRecord(rawLimits) || !isRecord(rawDefaults)) {
    reasons.add("money_limits_unverified");
    return;
  }
  if (args.actionLimits !== undefined) {
    const nextLimits = normalizeActionLimits(args.actionLimits) as Record<string, unknown>;
    if (changedMoneyKeys(normalizeActionLimits(rawLimits) as Record<string, unknown>, nextLimits).length) {
      reasons.add("money_tool_limits");
    }
  }
  if (args.toolApprovalDefaults !== undefined) {
    const currentDefaults: Record<string, unknown> = { ...normalizeToolApprovalDefaults(rawDefaults) };
    for (const [key, value] of Object.entries(rawDefaults)) if (!(key in currentDefaults)) currentDefaults[key] = value;
    const nextDefaults = normalizeToolApprovalDefaults(args.toolApprovalDefaults) as Record<string, unknown>;
    if (changedMoneyKeys(currentDefaults, nextDefaults).length) reasons.add("money_approval_weakened");
    // A money key the save path would not even keep (unknown / billing tool):
    // unclear intent → owner (unchanged from before).
    if (isRecord(args.toolApprovalDefaults)) {
      for (const key of Object.keys(args.toolApprovalDefaults)) if (!isNonMoneyToolKey(key) && !(key in nextDefaults)) reasons.add("money_approval_weakened");
    }
  }
}

/**
 * employees.issue grants a NEW employee its scopes / approval policy / limits:
 * same money rules as policy.patch with "no current scopes" (everything is an
 * addition), plus any spend limit → owner (employees.spend.set is owner-only).
 */
function classifyEmployeeIssue(args: Record<string, unknown>, reasons: Set<ApproverRequirementReason>) {
  if (args.scopes !== undefined && !Array.isArray(args.scopes)) reasons.add("unknown_policy_key");
  const scopes = Array.isArray(args.scopes) ? args.scopes : [];
  if (hasMoneyScope(scopes)) reasons.add("money_scope_change");
  if (args.spend !== undefined && args.spend !== null) reasons.add("money_spend_limit");
  if (args.toolApprovalDefaults !== undefined) {
    if (!isRecord(args.toolApprovalDefaults)) reasons.add("money_approval_weakened");
    else for (const key of Object.keys(args.toolApprovalDefaults)) if (!isNonMoneyToolKey(key)) reasons.add("money_approval_weakened");
  }
  if (args.actionLimits !== undefined && args.actionLimits !== null) {
    if (!isRecord(args.actionLimits)) reasons.add("money_tool_limits");
    else for (const key of Object.keys(args.actionLimits)) if (!isNonMoneyToolKey(key)) reasons.add("money_tool_limits");
  }
}

/** Canonical rules of a scheduling policy + whether any rule carries a cost cap. */
export interface SchedulingRulesState {
  rules: string;
  capped: boolean;
}

/**
 * Money inside the eight 2026-10-09 22:48 targets: schedulingPolicy rules'
 * costCapJpy (the cost ceiling a meeting slot may reach).
 * 木村 round 3 F1: apply.ts keeps a candidate if ANY rule passes, so under a
 * cap every rule matters — the state is ALL rules, canonical (keys sorted).
 * F3: costCapJpy is normalized like save-time validation (Number(v) whenever
 * the key is present, so null → a cap of 0).
 */
export function schedulingRulesState(policy: { rules?: unknown } | null | undefined): SchedulingRulesState {
  const rules = policy && Array.isArray(policy.rules) ? policy.rules : [];
  let capped = false;
  const normalized = rules.map((rule) => {
    if (!isRecord(rule) || rule.costCapJpy === undefined) return rule;
    capped = true;
    return { ...rule, costCapJpy: Number(rule.costCapJpy) };
  });
  return { rules: canonical(normalized), capped };
}

function isSchedulingRulesState(value: unknown): value is SchedulingRulesState {
  return isRecord(value) && typeof value.rules === "string" && typeof value.capped === "boolean";
}

function classifySchedulingPolicy(
  args: Record<string, unknown>,
  context: ApproverClassificationContext | null | undefined,
  reasons: Set<ApproverRequirementReason>
) {
  const state = context?.schedulingRules;
  if (!state || !isSchedulingRulesState(state.current) || !isSchedulingRulesState(state.ifCleared)) {
    reasons.add("money_cost_cap_unverified");
    return;
  }
  // F3: the handler inherits only for clearOverride WITH an employeeId; otherwise it saves args.rules.
  const clearing = args.clearOverride === true && typeof args.employeeId === "string" && args.employeeId.trim() !== "";
  const next = clearing ? state.ifCleared : schedulingRulesState(args);
  // F1: a cap before OR after + any rules change → owner.
  if ((state.current.capped || next.capped) && next.rules !== state.current.rules) reasons.add("money_cost_cap");
}

function classifyUnsafe(input: ApproverClassificationInput): ApproverRequirement | null {
  const tool = (input.tool || "").trim();
  if (!isApproverAuthorityTargetTool(tool)) return null;
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const mutation = isRecord(metadata.adminMutation) ? metadata.adminMutation : {};
  const reasons = new Set<ApproverRequirementReason>();
  if (SENSITIVE.has(tool)) reasons.add("sensitive_target_tool");
  if (mentionsStrongCapability(mutation)) reasons.add("strong_capability");
  if (tool === "approvalRoutes.patch") classifyApprovalRoutes(metadata, reasons);
  if (tool === "policy.patch") classifyPolicyPatch(mutation, input.context, reasons);
  if (tool === "employees.issue") classifyEmployeeIssue(mutation, reasons);
  if (tool === "schedulingPolicy.patch") classifySchedulingPolicy(mutation, input.context, reasons);
  if (tool === "employees.reinstate") {
    const scopes = input.context?.currentEmployeeScopes;
    if (!scopes) reasons.add("money_scope_unverified");
    else if (hasMoneyScope(scopes)) reasons.add("employee_has_money_scope");
  }
  if (reasons.size === 0) return { kind: "owner_or_designated_admin", reasons: ["standard_target_tool"] };
  return { kind: "owner", reasons: [...reasons] };
}

/**
 * Required approver kind for a ticket, or null when the tool is not a target.
 * Never throws: a classification error on a target tool → owner.
 */
export function classifyApproverRequirement(input: ApproverClassificationInput): ApproverRequirement | null {
  try {
    return classifyUnsafe(input);
  } catch {
    return isApproverAuthorityTargetTool(input.tool)
      ? { kind: "owner", reasons: ["classification_failed"] }
      : null;
  }
}

export function isRequiredApproverKind(value: unknown): value is RequiredApproverKind {
  return typeof value === "string" && (REQUIRED_APPROVER_KINDS as readonly string[]).includes(value);
}
