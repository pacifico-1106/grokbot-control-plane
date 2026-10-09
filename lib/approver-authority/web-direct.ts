/**
 * PR-D gap closure (2026-10-09): dashboard edits that change approvers or
 * permissions directly (no ticket). With APPROVER_AUTHORITY_ENABLED the person
 * saving must be someone who could have APPROVED that change as a ticket:
 * standard → owner or designated admin; owner-required (money / contract /
 * sensitive) → owner. Same decision function as approvals
 * (checkApproverAuthority → approver_authority_check in production).
 * There is no requester here — the actor is deciding for themselves, as an
 * owner already can on any ticket they could approve.
 *
 * Flag OFF → always ok (behaviour unchanged). No member id / unreadable
 * setting → refused (fail closed). Callers pass only the fields that actually
 * change; an empty list is not gated.
 */
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";
import { checkApproverAuthority } from "./verify";
import { classifyApproverRequirement, type ApproverRequirement, type ApproverRequirementReason } from "./targets";
import { approverAuthorityNextStepJa, approverAuthorityReplyJa } from "./reply";

/**
 * `kind` (review 2026-10-09 items 1–2): dashboard-only surfaces with no MCP
 * tool of their own (SoD warn policy, Slack conversation adapter, wake
 * binding, credential rotate) state their class directly; `tool` is then only
 * an audit label.
 */
export type WebDirectChange = { tool: string; adminMutation: Record<string, unknown>; kind?: ApproverRequirement["kind"] };

export type WebDirectResult =
  | { ok: true; requirement: ApproverRequirement | null }
  | { ok: false; reason: string; requirement: ApproverRequirement | null; messageJa: string; nextStepJa: string | null };

/** Strongest requirement over every change (owner wins), or null when none is a target. */
export function webDirectRequirement(
  changes: readonly WebDirectChange[],
  context?: Parameters<typeof classifyApproverRequirement>[0]["context"]
): ApproverRequirement | null {
  let kind: ApproverRequirement["kind"] | null = null;
  const reasons = new Set<ApproverRequirementReason>();
  for (const change of changes) {
    const r: ApproverRequirement | null = change.kind
      ? { kind: change.kind, reasons: [change.kind === "owner" ? "sensitive_target_tool" : "standard_target_tool"] }
      : classifyApproverRequirement({ tool: change.tool, metadata: { adminMutation: change.adminMutation }, context });
    if (!r) continue;
    if (r.kind === "owner") kind = "owner";
    else if (!kind) kind = r.kind;
    for (const reason of r.reasons) reasons.add(reason);
  }
  return kind ? { kind, reasons: [...reasons] } : null;
}

export async function assertWebActorApproverAuthority(input: {
  orgId: string;
  memberId: string | null | undefined;
  changes: readonly WebDirectChange[];
  context?: Parameters<typeof classifyApproverRequirement>[0]["context"];
  /** Audit label for the surface (e.g. "settings.notification_channels"). */
  surface?: string;
}): Promise<WebDirectResult> {
  if (!isApproverAuthorityEnabled()) return { ok: true, requirement: null };
  const requirement = webDirectRequirement(input.changes, input.context);
  if (!requirement) return { ok: true, requirement: null };
  const memberId = (input.memberId || "").trim();
  const decision = memberId
    ? await checkApproverAuthority({ orgId: input.orgId, memberId, requiredKind: requirement.kind, requesterMemberIds: [] })
    : ({ outcome: "deny", reason: "approver_member_required" } as const);
  if (decision.outcome === "allow") return { ok: true, requirement };
  // A designated admin on an owner-required change cannot save it directly.
  const reason = decision.outcome === "endorse" ? "owner_approval_required" : decision.reason;
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.policy",
    purpose: "approver_authority.web_denied",
    summary: `承認者・権限の直接変更を拒否（${reason}）`,
    metadata: {
      surface: input.surface ?? null,
      actorMemberId: memberId || null,
      reason,
      requiredApproverKind: requirement.kind,
      reasons: requirement.reasons,
      tools: input.changes.map((c) => c.tool),
    },
  }).catch(() => undefined);
  const messageJa =
    reason === "owner_approval_required"
      ? "この変更（お金・契約・センシティブな設定）はオーナーだけが保存できます。"
      : approverAuthorityReplyJa(reason) ?? "この変更を保存できる権限を確認できませんでした。";
  const nextStepJa =
    reason === "owner_approval_required"
      ? "オーナーに保存を依頼してください。"
      : approverAuthorityNextStepJa(reason) ?? "オーナーまたは指定管理者に保存を依頼してください。";
  return { ok: false, reason, requirement, messageJa, nextStepJa };
}

/** 403 body shared by the dashboard routes. */
export function webDirectDeniedBody(result: Extract<WebDirectResult, { ok: false }>) {
  return {
    ok: false,
    error: "approver_authority_denied",
    reason: result.reason,
    requiredApproverKind: result.requirement?.kind ?? null,
    message: result.messageJa,
    nextStepJa: result.nextStepJa,
  };
}

/** The dashboard actor's member id: session member (production) / demo actor (demo). Null → fail closed. */
export async function webSessionActorMemberId(req: Request): Promise<string | null> {
  const { isDemoMode } = await import("@/lib/mode");
  if (isDemoMode()) {
    const { resolveDemoActor } = await import("@/lib/team/demo-actor");
    return resolveDemoActor(req, null)?.id ?? null;
  }
  const { getSessionContext } = await import("@/lib/auth/session");
  const { activeSessionMember } = await import("@/lib/auth/active-member");
  return activeSessionMember(await getSessionContext())?.id ?? null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function sameSet(a: readonly unknown[] | null | undefined, b: readonly unknown[] | null | undefined): boolean {
  const x = new Set((a ?? []).map(String));
  const y = new Set((b ?? []).map(String));
  return x.size === y.size && [...x].every((v) => y.has(v));
}
