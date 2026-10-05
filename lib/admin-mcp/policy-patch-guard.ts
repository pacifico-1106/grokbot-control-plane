/**
 * Admin MCP policy.patch hardening (PR-C, 木村 / 八坂 2026-10-05).
 *
 * policy.patch writes exactly: scopes, allowedPurposes, approvalPolicy,
 * actionLimits and (optionally) toolApprovalDefaults of ONE employee of the
 * credential's org. Everything else is refused before a ticket exists:
 *  - keys that have their own reviewed admin tool → use_dedicated_tool + the
 *    tool name(s) (allowedAccounts, postingAs, approvalChannelId, grokBot…);
 *  - any other key (incl. orgId: the org only ever comes from the credential)
 *    → unsupported_key;
 *  - scopes outside ALL_SCOPES → unknown_scopes; bad approvalPolicy /
 *    allowedPurposes / actionLimits / toolApprovalDefaults → their own code.
 * sodOverrideAcknowledged from the agent is ignored (never queued): the SoD
 * acknowledgement is the human approval of a card that showed the verdict
 * (buildPolicyPatchCard → policyPatchCard snapshot, checked at fulfil).
 */
import { normalizeActionLimits } from "@/lib/action-gate";
import {
  CHOOSABLE_TOOL_APPROVALS,
  normalizeToolApprovalDefaults,
} from "@/lib/employees/approval-presets";
import { ALL_SCOPES, SCOPE_LABELS } from "@/lib/employees/policy-draft";
import { evaluateSod, SOD_OPERATOR_RESPONSIBILITY_JA, SOD_WARN_DOMAIN_LABELS } from "@/lib/employees/sod";
import { sodAckRequired } from "@/lib/employees/sod-override";
import { AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS, OUTBOUND_SEND_TOOL_IDS } from "@/lib/gateway/tools";
import type { ApprovalPolicy, Employee, EmployeeScope, SodVerdict, SodWarnPolicy } from "@/lib/types";

const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["auto", "risk_based", "always_human"];
const TOOL_APPROVAL_VALUES = ["auto", "risk_based", "always_human", "deny"] as const;
type ToolApprovalValue = (typeof TOOL_APPROVAL_VALUES)[number];

/** Keys policy.patch applies (+ jobId / approvalId plumbing). */
export const POLICY_PATCH_KEYS = [
  "employeeId",
  "scopes",
  "allowedPurposes",
  "approvalPolicy",
  "actionLimits",
  "toolApprovalDefaults",
  "jobId",
  "approvalId",
] as const;
/** Accepted but never used: the SoD acknowledgement is the card approval. */
export const POLICY_PATCH_IGNORED_KEYS = ["sodOverrideAcknowledged"] as const;
/** Fields with their own reviewed admin MCP tool. */
export const POLICY_PATCH_DEDICATED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  allowedAccounts: ["employees.allowedAccounts.add", "employees.allowedAccounts.remove"],
  postingAs: ["employees.postingIdentity.set"],
  approvalChannelId: ["setup.lineApproval.setEmployeeInbox"],
  grokBotAgentId: ["link"],
  grokBotWorkspaceId: ["link"],
};
/** Internal (server-built) field stored on the ticket; never accepted from the agent. */
const CARD_KEY = "policyPatchCard";

/** Per-tool values normalizeToolApprovalDefaults keeps (anything else would be silently dropped). */
function toolApprovalChoices(): Record<string, ToolApprovalValue[]> {
  const keys = new Set<string>([
    ...CHOOSABLE_TOOL_APPROVALS,
    ...OUTBOUND_SEND_TOOL_IDS,
    ...AUDIENCE_GATED_ALWAYS_HUMAN_HINT_TOOL_IDS,
    "comm.delete",
  ]);
  const out: Record<string, ToolApprovalValue[]> = {};
  for (const key of [...keys].sort()) {
    const allowed = TOOL_APPROVAL_VALUES.filter((v) => normalizeToolApprovalDefaults({ [key]: v })[key] === v);
    if (allowed.length) out[key] = allowed;
  }
  return out;
}
export const POLICY_PATCH_TOOL_APPROVAL_CHOICES: Readonly<Record<string, readonly ToolApprovalValue[]>> = toolApprovalChoices();

/** The explicit JSON schema for policy.patch (closed; toolApprovalDefaults per tool). */
export function policyPatchInputSchema(): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
} {
  return {
    type: "object" as const,
    properties: {
      employeeId: { type: "string", description: "AI社員 ID (this org only; the org comes from the credential)" },
      scopes: { type: "array", items: { type: "string", enum: [...ALL_SCOPES] }, minItems: 1 },
      allowedPurposes: { type: "array", items: { type: "string" } },
      approvalPolicy: { type: "string", enum: [...APPROVAL_POLICIES] },
      actionLimits: { type: "object", additionalProperties: true },
      toolApprovalDefaults: {
        type: "object",
        description:
          "Optional per-tool approval hints. Omit to keep the stored hints; when given, unspecified choosable tools fall back to the strict default (always_human).",
        properties: Object.fromEntries(
          Object.entries(POLICY_PATCH_TOOL_APPROVAL_CHOICES).map(([tool, values]) => [tool, { type: "string", enum: [...values] }])
        ),
        additionalProperties: false,
      },
      jobId: { type: "string" },
      approvalId: { type: "string", description: "Re-invoke with approved ticket ID" },
    },
    required: ["employeeId", "scopes", "approvalPolicy"],
    additionalProperties: false,
  };
}

export type PolicyPatchValue = {
  employeeId: string;
  scopes: EmployeeScope[];
  allowedPurposes: string[];
  approvalPolicy: ApprovalPolicy;
  actionLimits?: Record<string, unknown>;
  toolApprovalDefaults?: Record<string, ToolApprovalValue>;
  jobId?: string;
};
export type PolicyPatchRejection = { ok: false; code: string; message: string } & Record<string, unknown>;
export type PolicyPatchParse = { ok: true; value: PolicyPatchValue; ignoredKeys: string[] } | PolicyPatchRejection;

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Validate policy.patch arguments. `fromTicket` = re-validation of a stored
 * ticket at fulfil (the server-built card snapshot key is allowed there).
 */
export function parsePolicyPatchArgs(args: Record<string, unknown>, opts: { fromTicket?: boolean } = {}): PolicyPatchParse {
  const keys = Object.keys(args);
  const dedicated = keys.filter((k) => k in POLICY_PATCH_DEDICATED_TOOLS).sort();
  if (dedicated.length) {
    const dedicatedTools = Object.fromEntries(dedicated.map((k) => [k, [...POLICY_PATCH_DEDICATED_TOOLS[k]]]));
    const first = POLICY_PATCH_DEDICATED_TOOLS[dedicated[0]][0];
    return {
      ok: false,
      code: "use_dedicated_tool",
      message: `policy.patch では ${dedicated.join(", ")} を変更できません。専用ツール（${dedicated.map((k) => POLICY_PATCH_DEDICATED_TOOLS[k].join(" / ")).join("、")}）を使ってください。`,
      keys: dedicated,
      dedicatedTool: first,
      dedicatedTools,
    };
  }
  const allowed = new Set<string>([...POLICY_PATCH_KEYS, ...POLICY_PATCH_IGNORED_KEYS, ...(opts.fromTicket ? [CARD_KEY] : [])]);
  const unsupported = keys.filter((k) => !allowed.has(k)).sort();
  if (unsupported.length) {
    return {
      ok: false,
      code: "unsupported_key",
      message: unsupported.includes("orgId")
        ? "組織は管理MCPの認証から決まります（orgId は指定できません）。policy.patch が変更できるのは scopes / allowedPurposes / approvalPolicy / actionLimits / toolApprovalDefaults だけです。"
        : "policy.patch が変更できるのは scopes / allowedPurposes / approvalPolicy / actionLimits / toolApprovalDefaults だけです。それ以外はダッシュボードで変更してください。",
      keys: unsupported.slice(0, 20).map((k) => clip(k)),
    };
  }
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId) return { ok: false, code: "employee_id_required", message: "employeeId が必要です" };
  if (!Array.isArray(args.scopes) || args.scopes.length === 0) {
    return { ok: false, code: "scopes_required", message: "できること（scopes）を1つ以上指定してください" };
  }
  const unknownScopes = args.scopes.filter((s) => typeof s !== "string" || !ALL_SCOPES.includes(s as EmployeeScope));
  if (unknownScopes.length) {
    return {
      ok: false,
      code: "unknown_scopes",
      message: "存在しない権限（scope）が含まれています。変更は行われていません。",
      unknownScopes: unknownScopes.slice(0, 20).map((s) => clip(String(s))),
    };
  }
  const scopes = [...new Set(args.scopes as EmployeeScope[])];
  const approvalPolicy = args.approvalPolicy as ApprovalPolicy;
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
    return { ok: false, code: "invalid_approval_policy", message: "approvalPolicy は auto / risk_based / always_human のいずれかです" };
  }
  let allowedPurposes: string[] = [];
  if (args.allowedPurposes !== undefined) {
    if (!Array.isArray(args.allowedPurposes) || args.allowedPurposes.some((p) => typeof p !== "string")) {
      return { ok: false, code: "invalid_allowed_purposes", message: "allowedPurposes は文字列の配列です" };
    }
    allowedPurposes = (args.allowedPurposes as string[]).map((p) => p.trim()).filter(Boolean);
  }
  if (args.actionLimits !== undefined && !isPlainObject(args.actionLimits)) {
    return { ok: false, code: "invalid_action_limits", message: "actionLimits はオブジェクトです" };
  }
  let toolApprovalDefaults: Record<string, ToolApprovalValue> | undefined;
  if (args.toolApprovalDefaults !== undefined) {
    const tad = args.toolApprovalDefaults;
    const invalidKeys = !isPlainObject(tad)
      ? ["(not an object)"]
      : Object.entries(tad)
          .filter(([k, v]) => !(POLICY_PATCH_TOOL_APPROVAL_CHOICES[k] ?? []).includes(v as ToolApprovalValue))
          .map(([k]) => clip(k));
    if (invalidKeys.length) {
      return {
        ok: false,
        code: "invalid_tool_approval_defaults",
        message: "toolApprovalDefaults に受け付けないツールまたは値があります（スキーマの一覧を参照）。変更は行われていません。",
        invalidKeys: invalidKeys.slice(0, 20),
      };
    }
    toolApprovalDefaults = tad as Record<string, ToolApprovalValue>;
  }
  const ignoredKeys = POLICY_PATCH_IGNORED_KEYS.filter((k) => k in args);
  return {
    ok: true,
    value: {
      employeeId,
      scopes,
      allowedPurposes,
      approvalPolicy,
      ...(args.actionLimits !== undefined ? { actionLimits: args.actionLimits as Record<string, unknown> } : {}),
      ...(toolApprovalDefaults ? { toolApprovalDefaults } : {}),
      ...(typeof args.jobId === "string" ? { jobId: args.jobId } : {}),
    },
    ignoredKeys: [...ignoredKeys],
  };
}

/** What the approver saw: the SoD verdict at the time the card was built. */
export type PolicyPatchCardSnapshot = { version: 1; sodLevel: SodVerdict["level"]; sodDomains: string[]; sodNeedsAck: boolean };

export function policyPatchSod(scopes: EmployeeScope[], approvalPolicy: ApprovalPolicy, sodPolicy: SodWarnPolicy | null) {
  const verdict = evaluateSod(scopes, sodPolicy);
  const needsAck = sodAckRequired({ verdict, requested: approvalPolicy, acknowledged: false });
  return { verdict, needsAck };
}

const sortedDomains = (domains: readonly string[]) => [...domains].filter((d) => d !== "safe").sort();
export function sameSodAsCard(card: unknown, verdict: SodVerdict): boolean {
  if (!isPlainObject(card) || card.version !== 1) return false;
  return card.sodLevel === verdict.level && JSON.stringify(sortedDomains((card.sodDomains as string[]) ?? [])) === JSON.stringify(sortedDomains(verdict.domains));
}
export function readPolicyPatchCard(args: Record<string, unknown>): unknown {
  return args[CARD_KEY];
}

/**
 * Fulfil-time SoD gate (kept separate from approver-role checks): when the
 * verdict needs an operator acknowledgement, the only acknowledgement is the
 * human approval of a card that showed this same verdict. Missing card
 * snapshot (older ticket / agent-only ack) or a changed verdict → refused.
 */
export type PolicyPatchSodGate =
  | { ok: true; verdict: SodVerdict; needsAck: boolean }
  | { ok: false; error: "sod_not_shown_on_card" | "sod_changed_since_card"; nextStepJa: string };
export function checkPolicyPatchSodAck(
  args: Record<string, unknown>,
  value: Pick<PolicyPatchValue, "scopes" | "approvalPolicy">,
  sodPolicy: SodWarnPolicy | null
): PolicyPatchSodGate {
  const { verdict, needsAck } = policyPatchSod(value.scopes, value.approvalPolicy, sodPolicy);
  if (!needsAck) return { ok: true, verdict, needsAck };
  const card = readPolicyPatchCard(args);
  if (card === undefined) {
    return {
      ok: false,
      error: "sod_not_shown_on_card",
      nextStepJa: "この承認カードには職務分離(SoD)の判定が表示されていませんでした。変更は行われていません。policy.patch をもう一度依頼してください。",
    };
  }
  if (!sameSodAsCard(card, verdict)) {
    return {
      ok: false,
      error: "sod_changed_since_card",
      nextStepJa: "承認カードの表示後に職務分離(SoD)の判定が変わりました。変更は行われていません。policy.patch をもう一度依頼してください。",
    };
  }
  return { ok: true, verdict, needsAck };
}

const domainLabel = (d: string) => (SOD_WARN_DOMAIN_LABELS as Record<string, string>)[d] ?? (d === "browser" ? "ブラウザ" : d);
const scopeLabel = (s: EmployeeScope) => `${s}（${SCOPE_LABELS[s] ?? s}）`;
function listDiff(before: readonly string[], after: readonly string[]) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}
const short = (v: unknown) => clip(JSON.stringify(v ?? null) ?? "null", 40);

/**
 * The approval card text (before → after + SoD verdict) and the snapshot the
 * fulfil step compares against. Only policy fields: no secret, hash, prefix
 * or token of the employee is ever read here.
 */
export function buildPolicyPatchCard(
  employee: Pick<Employee, "id" | "displayName" | "scopes" | "allowedPurposes" | "approvalPolicy" | "actionLimits" | "toolApprovalDefaults">,
  value: PolicyPatchValue,
  sodPolicy: SodWarnPolicy | null
): { summaryJa: string; snapshot: PolicyPatchCardSnapshot } {
  const lines: string[] = [`管理エージェントから権限の変更依頼: ${clip(employee.displayName, 40)}（${employee.id}）`];
  const scopes = listDiff(employee.scopes, value.scopes);
  lines.push(
    scopes.added.length || scopes.removed.length
      ? `・できること: ${[
          scopes.added.length ? `追加: ${scopes.added.map((s) => scopeLabel(s as EmployeeScope)).join("、")}` : "",
          scopes.removed.length ? `削除: ${scopes.removed.map((s) => scopeLabel(s as EmployeeScope)).join("、")}` : "",
        ].filter(Boolean).join(" / ")}`
      : "・できること: 変更なし"
  );
  lines.push(
    employee.approvalPolicy === value.approvalPolicy
      ? `・承認方針: 変更なし（${value.approvalPolicy}）`
      : `・承認方針: ${employee.approvalPolicy} → ${value.approvalPolicy}`
  );
  const purposes = listDiff(employee.allowedPurposes ?? [], value.allowedPurposes);
  lines.push(
    purposes.added.length || purposes.removed.length
      ? `・用途: ${[
          purposes.added.length ? `追加: ${purposes.added.slice(0, 10).map((p) => clip(p, 40)).join("、")}` : "",
          purposes.removed.length ? `削除: ${purposes.removed.slice(0, 10).map((p) => clip(p, 40)).join("、")}` : "",
        ].filter(Boolean).join(" / ")}`
      : "・用途: 変更なし"
  );
  const limitsBefore = normalizeActionLimits(employee.actionLimits) as Record<string, unknown>;
  const limitsAfter = normalizeActionLimits(value.actionLimits) as Record<string, unknown>;
  const limitKeys = [...new Set([...Object.keys(limitsBefore), ...Object.keys(limitsAfter)])].filter(
    (k) => JSON.stringify(limitsBefore[k]) !== JSON.stringify(limitsAfter[k])
  );
  lines.push(
    limitKeys.length
      ? `・実行上限: ${limitKeys.slice(0, 10).map((k) => `${k}: ${short(limitsBefore[k])} → ${short(limitsAfter[k])}`).join("、")}`
      : "・実行上限: 変更なし"
  );
  if (value.toolApprovalDefaults) {
    const before = (employee.toolApprovalDefaults ?? {}) as Record<string, unknown>;
    const after = normalizeToolApprovalDefaults(value.toolApprovalDefaults) as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
    lines.push(
      changed.length
        ? `・ツール別の承認: ${changed.map((k) => `${k}: ${String(before[k] ?? "既定")} → ${String(after[k] ?? "既定")}`).join("、")}`
        : "・ツール別の承認: 変更なし"
    );
  }
  const { verdict, needsAck } = policyPatchSod(value.scopes, value.approvalPolicy, sodPolicy);
  const domains = sortedDomains(verdict.domains);
  if (verdict.level === "ok") {
    lines.push("・職務分離(SoD): 問題なし");
  } else {
    lines.push(`・職務分離(SoD): 警告（${domains.map(domainLabel).join("・") || "高リスク"}）。${SOD_OPERATOR_RESPONSIBILITY_JA}`);
    lines.push(
      needsAck
        ? "承認すると、この職務分離の警告を確認したものとして扱います（エージェントの申告は使いません）。"
        : "承認方針が always_human のため、警告の確認は不要です。"
    );
  }
  lines.push("反映しますか？");
  return {
    summaryJa: lines.join("\n"),
    snapshot: { version: 1, sodLevel: verdict.level, sodDomains: domains, sodNeedsAck: needsAck },
  };
}

export const POLICY_PATCH_CARD_KEY = CARD_KEY;
