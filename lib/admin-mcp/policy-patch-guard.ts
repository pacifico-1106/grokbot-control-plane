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
 *
 * 木村 review 2026-10-05 10:39:
 *  - B1: the SoD verdict and the approval policy come right after the heading,
 *    and the whole card must fit the shortest surface cut (Slack 400 chars):
 *    a card that would be cut is refused at intake, and a stored card that is
 *    not marked / not short enough is refused at fulfil (card_truncated).
 *  - allowedPurposes / actionLimits omitted = keep the stored value; an
 *    explicit [] / {} clears them and the card warns first.
 */
import { normalizeActionLimits } from "@/lib/action-gate";
import {
  CHOOSABLE_TOOL_APPROVALS,
  normalizeToolApprovalDefaults,
} from "@/lib/employees/approval-presets";
import {
  APPROVAL_SUMMARY_FULL_ON_ALL_SURFACES_MAX_CHARS,
  approvalSummaryChars,
  approvalSummaryFitsAllSurfaces,
} from "@/lib/approvals/summary-limits";
import { ALL_SCOPES, SCOPE_LABELS } from "@/lib/employees/policy-draft";
import { isPurposeKey, PURPOSE_KEY_MAX_CHARS, PURPOSE_KEY_PATTERN } from "@/lib/employees/purposes";
import {
  evaluateSod,
  isComboSodWarn,
  SOD_BROWSER_SESSION_JA,
  SOD_OPERATOR_RESPONSIBILITY_JA,
  SOD_WARN_DOMAIN_LABELS,
} from "@/lib/employees/sod";
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
/** allowedPurposes bounds (each item: a purpose key, see lib/employees/purposes.ts). */
export const POLICY_PATCH_MAX_PURPOSES = 20;
/** The card must be shown in full on every approval surface. */
export const POLICY_PATCH_CARD_MAX_CHARS = APPROVAL_SUMMARY_FULL_ON_ALL_SURFACES_MAX_CHARS;

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
      allowedPurposes: {
        type: "array",
        description: "Purpose keys. Omit to keep the stored list; [] removes every purpose restriction (the card warns).",
        items: { type: "string", pattern: PURPOSE_KEY_PATTERN, maxLength: PURPOSE_KEY_MAX_CHARS },
        maxItems: POLICY_PATCH_MAX_PURPOSES,
      },
      approvalPolicy: { type: "string", enum: [...APPROVAL_POLICIES] },
      actionLimits: {
        type: "object",
        description: "Per-tool { perDay, perMonth }. Omit to keep the stored limits; {} removes every limit (the card warns).",
        additionalProperties: true,
      },
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
  /** undefined = keep the stored list. */
  allowedPurposes?: string[];
  approvalPolicy: ApprovalPolicy;
  /** undefined = keep the stored limits. */
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
  let allowedPurposes: string[] | undefined;
  if (args.allowedPurposes !== undefined) {
    if (!Array.isArray(args.allowedPurposes) || args.allowedPurposes.some((p) => typeof p !== "string")) {
      return { ok: false, code: "invalid_allowed_purposes", reason: "not_string_array", message: "allowedPurposes は文字列の配列です。変更は行われていません。" };
    }
    if (args.allowedPurposes.length > POLICY_PATCH_MAX_PURPOSES) {
      return {
        ok: false,
        code: "invalid_allowed_purposes",
        reason: "too_many",
        maxItems: POLICY_PATCH_MAX_PURPOSES,
        message: `allowedPurposes は ${POLICY_PATCH_MAX_PURPOSES} 件までです。変更は行われていません。`,
      };
    }
    const trimmed = (args.allowedPurposes as string[]).map((p) => p.trim());
    const invalid = trimmed.filter((p) => !isPurposeKey(p));
    if (invalid.length) {
      return {
        ok: false,
        code: "invalid_allowed_purposes",
        reason: "invalid_key",
        maxLength: PURPOSE_KEY_MAX_CHARS,
        invalidPurposes: invalid.slice(0, 20).map((p) => clip(p)),
        message: `allowedPurposes は用途キー（英字で始まる英数字・. _ -、${PURPOSE_KEY_MAX_CHARS}文字まで）の配列です。変更は行われていません。`,
      };
    }
    allowedPurposes = [...new Set(trimmed)];
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
      ...(allowedPurposes !== undefined ? { allowedPurposes } : {}),
      approvalPolicy,
      ...(args.actionLimits !== undefined ? { actionLimits: args.actionLimits as Record<string, unknown> } : {}),
      ...(toolApprovalDefaults ? { toolApprovalDefaults } : {}),
      ...(typeof args.jobId === "string" ? { jobId: args.jobId } : {}),
    },
    ignoredKeys: [...ignoredKeys],
  };
}

/**
 * What the approver saw: the SoD verdict at the time the card was built, and
 * that the whole card fits every surface (version 2; version 1 snapshots did
 * not check this and are refused at fulfil).
 */
export type PolicyPatchCardSnapshot = {
  version: 2;
  sodLevel: SodVerdict["level"];
  sodDomains: string[];
  sodNeedsAck: boolean;
  fitsAllSurfaces: boolean;
  summaryChars: number;
  /** Fields the patch empties on purpose (explicit [] / {}), warned on the card. */
  clears: Array<"allowedPurposes" | "actionLimits">;
};

export function policyPatchSod(scopes: EmployeeScope[], approvalPolicy: ApprovalPolicy, sodPolicy: SodWarnPolicy | null) {
  const verdict = evaluateSod(scopes, sodPolicy);
  const needsAck = sodAckRequired({ verdict, requested: approvalPolicy, acknowledged: false });
  return { verdict, needsAck };
}

const sortedDomains = (domains: readonly string[]) => [...domains].filter((d) => d !== "safe").sort();
export function sameSodAsCard(card: unknown, verdict: SodVerdict): boolean {
  if (!isPlainObject(card) || card.version !== 2) return false;
  return card.sodLevel === verdict.level && JSON.stringify(sortedDomains((card.sodDomains as string[]) ?? [])) === JSON.stringify(sortedDomains(verdict.domains));
}
export function readPolicyPatchCard(args: Record<string, unknown>): unknown {
  return args[CARD_KEY];
}

/**
 * Fulfil-time card gate (B1): a ticket that carries a card snapshot is only
 * applied when that card was shown in full on every surface — the snapshot
 * is version 2, marked fitsAllSurfaces, and the stored summary is within the
 * shortest cut. Otherwise nothing on the card (SoD included) counts as shown.
 * Tickets without any snapshot fall through to the SoD gate below.
 */
export type PolicyPatchCardGate = { ok: true } | { ok: false; error: "card_truncated"; nextStepJa: string };
export function checkPolicyPatchCardShown(args: Record<string, unknown>, approvalSummary: string | null | undefined): PolicyPatchCardGate {
  const card = readPolicyPatchCard(args);
  if (card === undefined) return { ok: true };
  const shown =
    isPlainObject(card) &&
    card.version === 2 &&
    card.fitsAllSurfaces === true &&
    approvalSummaryFitsAllSurfaces(approvalSummary ?? "");
  if (shown) return { ok: true };
  return {
    ok: false,
    error: "card_truncated",
    nextStepJa: `この承認カードは通知で途中までしか表示されない可能性がありました（${POLICY_PATCH_CARD_MAX_CHARS}文字超、または旧形式）。職務分離(SoD)の判定を含め、表示されたものとして扱えないため、変更は行われていません。変更内容を分けて policy.patch をもう一度依頼してください。`,
  };
}

/** The badge belongs to the requesting admin agent (grokBotAgentId or actorId) — intake and fulfil. */
export function boundToRequestingAdmin(
  requester: { grokBotAgentId?: string | null; actorId?: string | null } | null | undefined,
  bindingAgentId: string | null | undefined
): boolean {
  const bound = (bindingAgentId || "").trim();
  if (!bound || !requester) return false;
  return [requester.grokBotAgentId, requester.actorId].some((id) => (id || "").trim() === bound);
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

type CardEmployee = Pick<Employee, "id" | "displayName" | "scopes" | "allowedPurposes" | "approvalPolicy" | "actionLimits" | "toolApprovalDefaults">;

/** SoD verdict lines (B2: the no-ack reason follows the requested policy). */
function sodLines(verdict: SodVerdict, needsAck: boolean, approvalPolicy: ApprovalPolicy): string[] {
  if (verdict.level === "ok") return ["・職務分離(SoD): 問題なし"];
  const domains = sortedDomains(verdict.domains);
  const labels = domains.map(domainLabel).join("・") || "高リスク";
  const combo = isComboSodWarn(verdict);
  const first = combo
    ? `・職務分離(SoD): 警告（${labels}）。${SOD_OPERATOR_RESPONSIBILITY_JA}`
    : `・職務分離(SoD): 注意（${labels}）。${domains.includes("browser") ? SOD_BROWSER_SESSION_JA : ""}`;
  let second: string;
  if (needsAck) second = "承認すると、この職務分離の警告を確認したものとして扱います（エージェントの申告は使いません）。";
  else if (approvalPolicy === "always_human") second = "承認方針が always_human（毎回人が承認）のため、警告の確認は不要です。";
  else second = `承認方針は ${approvalPolicy} です。高リスク権限の組み合わせではないため、警告の確認は不要です。`;
  return [first, second];
}

function cardText(employee: CardEmployee, value: PolicyPatchValue, sod: { verdict: SodVerdict; needsAck: boolean }, detailed: boolean) {
  const lines: string[] = [`管理エージェントから権限の変更依頼: ${clip(employee.displayName, 40)}（${employee.id}）`];
  // B1: what the approver must see first — SoD verdict, then the approval policy.
  lines.push(...sodLines(sod.verdict, sod.needsAck, value.approvalPolicy));
  lines.push(
    employee.approvalPolicy === value.approvalPolicy
      ? `・承認方針: 変更なし（${value.approvalPolicy}）`
      : `・承認方針: ${employee.approvalPolicy} → ${value.approvalPolicy}`
  );
  const clears: PolicyPatchCardSnapshot["clears"] = [];
  const purposesBefore = employee.allowedPurposes ?? [];
  if (value.allowedPurposes !== undefined && value.allowedPurposes.length === 0 && purposesBefore.length > 0) {
    clears.push("allowedPurposes");
    lines.push("⚠ 用途の制限をすべて外します（どの用途でも実行できるようになります）。");
  }
  const limitsBefore = normalizeActionLimits(employee.actionLimits) as Record<string, unknown>;
  const limitsAfter = value.actionLimits !== undefined ? (normalizeActionLimits(value.actionLimits) as Record<string, unknown>) : limitsBefore;
  if (value.actionLimits !== undefined && Object.keys(limitsAfter).length === 0 && Object.keys(limitsBefore).length > 0) {
    clears.push("actionLimits");
    lines.push("⚠ 実行上限をすべて外します（回数の上限がなくなります）。");
  }
  const scopes = listDiff(employee.scopes, value.scopes);
  const scopeText = (list: string[]) => list.map((s) => (detailed ? scopeLabel(s as EmployeeScope) : s)).join("、");
  lines.push(
    scopes.added.length || scopes.removed.length
      ? `・できること: ${[
          scopes.added.length ? `追加: ${scopeText(scopes.added)}` : "",
          scopes.removed.length ? `削除: ${scopeText(scopes.removed)}` : "",
        ].filter(Boolean).join(" / ")}`
      : "・できること: 変更なし"
  );
  const purposes = listDiff(purposesBefore, value.allowedPurposes ?? purposesBefore);
  lines.push(
    purposes.added.length || purposes.removed.length
      ? `・用途: ${[
          purposes.added.length ? `追加: ${purposes.added.join("、")}` : "",
          purposes.removed.length ? `削除: ${purposes.removed.join("、")}` : "",
        ].filter(Boolean).join(" / ")}`
      : "・用途: 変更なし"
  );
  const limitKeys = [...new Set([...Object.keys(limitsBefore), ...Object.keys(limitsAfter)])].filter(
    (k) => JSON.stringify(limitsBefore[k]) !== JSON.stringify(limitsAfter[k])
  );
  lines.push(
    limitKeys.length
      ? `・実行上限: ${limitKeys.map((k) => `${k}: ${short(limitsBefore[k])} → ${short(limitsAfter[k])}`).join("、")}`
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
  lines.push("反映しますか？");
  return { text: lines.join("\n"), clears };
}

/**
 * The approval card text (heading → SoD verdict → approval policy → clear
 * warnings → before/after diff) and the snapshot the fulfil step compares
 * against. Every changed item is listed (no "他N件"): when the labelled form
 * is longer than the shortest surface cut the scope ids are shown without
 * labels, and when even that does not fit, `fitsAllSurfaces` is false and the
 * caller must refuse the request. Only policy fields: no secret, hash, prefix
 * or token of the employee is ever read here.
 */
export function buildPolicyPatchCard(
  employee: CardEmployee,
  value: PolicyPatchValue,
  sodPolicy: SodWarnPolicy | null
): { summaryJa: string; snapshot: PolicyPatchCardSnapshot; fitsAllSurfaces: boolean; summaryChars: number } {
  const sod = policyPatchSod(value.scopes, value.approvalPolicy, sodPolicy);
  let card = cardText(employee, value, sod, true);
  if (!approvalSummaryFitsAllSurfaces(card.text)) card = cardText(employee, value, sod, false);
  const fitsAllSurfaces = approvalSummaryFitsAllSurfaces(card.text);
  const summaryChars = approvalSummaryChars(card.text);
  return {
    summaryJa: card.text,
    fitsAllSurfaces,
    summaryChars,
    snapshot: {
      version: 2,
      sodLevel: sod.verdict.level,
      sodDomains: sortedDomains(sod.verdict.domains),
      sodNeedsAck: sod.needsAck,
      fitsAllSurfaces,
      summaryChars,
      clears: card.clears,
    },
  };
}

/** Intake refusal for a card that cannot be shown in full (no ticket is created). */
export function policyPatchCardTooLong(summaryChars: number): PolicyPatchRejection {
  return {
    ok: false,
    code: "policy_patch_card_too_long",
    retryable: true,
    cardChars: summaryChars,
    maxChars: POLICY_PATCH_CARD_MAX_CHARS,
    message: `承認カードが ${POLICY_PATCH_CARD_MAX_CHARS} 文字を超え、Slack / LINE の通知で途中までしか表示されないため、依頼を作成しませんでした。`,
    nextStepJa: "変更内容を分けて（例: できることの変更と用途・実行上限の変更を別々に）policy.patch を依頼してください。",
  };
}

export const POLICY_PATCH_CARD_KEY = CARD_KEY;
