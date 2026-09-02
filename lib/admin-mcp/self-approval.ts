/**
 * Admin agent cannot approve its own request.
 * Compare grokBotAgentId / actor of requester vs resolver.
 */
export const SELF_APPROVAL_DENIED = "self_approval_denied";
export const SELF_APPROVAL_MESSAGE_JA =
  "管理エージェントは自分の申請を承認できません。別の人が承認してください。";

export type AdminRequester = {
  kind: "admin_agent";
  grokBotAgentId: string | null;
  actorId: string | null;
};

export type ApprovalResolver = {
  grokBotAgentId?: string | null;
  actorId?: string | null;
  actor?: string | null;
};

function norm(value: string | null | undefined): string {
  return (value || "").trim();
}

export function parseAdminRequester(
  metadata: Record<string, unknown> | null | undefined
): AdminRequester | null {
  const raw = metadata?.adminRequester;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== "admin_agent") return null;
  return {
    kind: "admin_agent",
    grokBotAgentId:
      typeof rec.grokBotAgentId === "string" ? rec.grokBotAgentId : null,
    actorId: typeof rec.actorId === "string" ? rec.actorId : null,
  };
}

export function isSelfApproval(
  requester: AdminRequester | null | undefined,
  resolver: ApprovalResolver
): boolean {
  if (!requester) return false;
  const reqAgent = norm(requester.grokBotAgentId);
  const resAgent = norm(resolver.grokBotAgentId);
  if (reqAgent && resAgent && reqAgent === resAgent) return true;

  const reqActor = norm(requester.actorId);
  const resActor = norm(resolver.actorId) || norm(resolver.actor);
  if (reqActor && resActor && reqActor === resActor) return true;
  return false;
}

export function assertNotSelfApproval(
  metadata: Record<string, unknown> | null | undefined,
  resolver: ApprovalResolver
): void {
  const requester = parseAdminRequester(metadata);
  if (isSelfApproval(requester, resolver)) {
    throw Object.assign(new Error(SELF_APPROVAL_DENIED), {
      code: SELF_APPROVAL_DENIED,
      messageJa: SELF_APPROVAL_MESSAGE_JA,
    });
  }
}

export function isSelfApprovalDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return error instanceof Error && error.message === SELF_APPROVAL_DENIED;
  }
  const code = (error as { code?: string }).code;
  if (code === SELF_APPROVAL_DENIED) return true;
  return error instanceof Error && error.message === SELF_APPROVAL_DENIED;
}
