import type { AuditEvent } from "@/lib/types";
import { opaqueAuditId } from "./mask";
import type { AuditResultKind, AuditResultView } from "./types";

export const AUDIT_RESULT_LABEL_JA: Record<AuditResultKind, string> = {
  success: "成功",
  failure: "失敗",
  denied: "拒否",
  pending: "待ち",
  unknown: "不明",
};

/** Short reason copy (PR-1 skeleton). Unknown codes stay opaque — never dump values. */
export const AUDIT_REASON_JA: Record<string, { kind: AuditResultKind; ja: string }> = {
  needs_approval: { kind: "pending", ja: "人の承認待ち" },
  approved: { kind: "success", ja: "承認されて実行しました" },
  rejected: { kind: "denied", ja: "承認者が却下しました" },
  expired: { kind: "denied", ja: "承認期限が切れました" },
  revision_requested: { kind: "pending", ja: "修正依頼です。まだ実行していません" },
  egress_denied: { kind: "denied", ja: "相手先または情報区分のルールで送れません" },
  secret_detected_in_payload: { kind: "denied", ja: "秘密情報の可能性がある値を検出して拒否しました" },
  approval_held: { kind: "denied", ja: "緊急停止中の承認のため実行しませんでした" },
  "action_limit.denied": { kind: "denied", ja: "操作回数の上限です" },
  action_limit: { kind: "denied", ja: "操作回数の上限です" },
  topic_gate: { kind: "pending", ja: "機微トピックのため承認が必要です" },
  duplicate_reply_suppressed: { kind: "denied", ja: "同じ内容の重複送信を止めました" },
  cross_employee_duplicate: { kind: "success", ja: "他のAI社員の投稿と似ています（送信はしています）" },
  post_outcome_unknown: { kind: "failure", ja: "投稿できたか確認できません" },
  duplicate_check_unavailable: { kind: "failure", ja: "重複チェックが使えず送信していません" },
  thread_busy: { kind: "failure", ja: "同じスレッドで別の返信が処理中です" },
  thread_moved_on: { kind: "denied", ja: "このスレッドは既に返信済みです" },
  slack_channel_required: { kind: "failure", ja: "Slackチャネルが無く送信していません" },
  delivery_unsupported_surface: { kind: "denied", ja: "この窓口への送信には未対応です" },
  channel_not_supported: { kind: "denied", ja: "この窓口への送信には未対応です" },
  conversation_not_sent: { kind: "failure", ja: "メッセージは送信していません" },
  conversation_org_mismatch: { kind: "denied", ja: "会話の組織が一致しません" },
  conversation_channel_mismatch: { kind: "denied", ja: "会話のチャネルが一致しません" },
  conversation_target_mismatch: { kind: "denied", ja: "LINEの相手が一致しません" },
  session_org_mismatch: { kind: "denied", ja: "セッションの組織が一致しません" },
  provider_rate_limited: { kind: "failure", ja: "先方の利用上限です。時間をおいてください" },
  slack_post_failed: { kind: "failure", ja: "送信に失敗しました" },
  line_post_failed: { kind: "failure", ja: "送信に失敗しました" },
  sns_publish_failed: { kind: "failure", ja: "送信に失敗しました" },
  file_egress_denied: { kind: "denied", ja: "ファイル添付がルールで拒否されました" },
  admin_policy_required: { kind: "denied", ja: "管理操作の承認者が未設定です" },
  approver_is_requester: { kind: "denied", ja: "申請者本人は承認できません" },
  approver_not_authorized: { kind: "denied", ja: "この操作を承認できる人ではありません" },
  owner_approval_required: { kind: "denied", ja: "オーナーの承認が必要です" },
  approver_member_required: { kind: "denied", ja: "保存した人の所属が確認できません" },
  approver_identity_unverified: { kind: "denied", ja: "承認者の本人確認ができません" },
  no_approver_resolvable: { kind: "denied", ja: "届け先の承認者が見つかりません" },
  project_access: { kind: "denied", ja: "担当プロジェクトの外の情報は扱えません" },
  feature_disabled: { kind: "denied", ja: "この機能は現在オフです" },
  stale_base: { kind: "failure", ja: "元の設定が変わったため反映しませんでした" },
  "plan.fulfill_blocked": { kind: "denied", ja: "承認後にプランが変わり実行できません" },
};

const ACTION_REASON: Record<string, string> = {
  "approval.requested": "needs_approval",
  "approval.revision_requested": "revision_requested",
  "approval.expired": "expired",
  "secret_detection.blocked": "secret_detected_in_payload",
  "action_limit.denied": "action_limit.denied",
  "topic_gate.triggered": "topic_gate",
  "comm_reply.duplicate_suppressed": "duplicate_reply_suppressed",
  "comm_reply.cross_employee_duplicate": "cross_employee_duplicate",
  "comm_reply.post_outcome_unknown": "post_outcome_unknown",
  "comm_reply.dedup_unavailable": "duplicate_check_unavailable",
  "thread_guard.busy": "thread_busy",
  "thread_guard.moved_on": "thread_moved_on",
  "slack.post_failed": "slack_post_failed",
  "line.post_failed": "line_post_failed",
  "sns.publish_failed": "sns_publish_failed",
  "slack.file_egress_denied": "file_egress_denied",
  "gateway.conversation_org_mismatch": "conversation_org_mismatch",
  "gateway.conversation_channel_mismatch": "conversation_channel_mismatch",
  "line.conversation_target_mismatch": "conversation_target_mismatch",
  "gateway.session_org_mismatch": "session_org_mismatch",
  "comm.not_sent": "conversation_not_sent",
  "plan.fulfill_blocked": "plan.fulfill_blocked",
  "employee.project_access_refused": "project_access",
  "information_asset.project_refused": "project_access",
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function metaCode(meta: Record<string, unknown>): string | null {
  return asString(meta.code) ?? asString(meta.reasonCode) ?? asString(meta.reason);
}

function reasonView(code: string | null, fallbackKind: AuditResultKind): AuditResultView {
  if (!code) return { kind: fallbackKind, reasonCode: null, reasonJa: null };
  const mapped = AUDIT_REASON_JA[code];
  if (mapped) return { kind: mapped.kind, reasonCode: code, reasonJa: mapped.ja };
  const opaque = opaqueAuditId(code);
  if (opaque && opaque.startsWith("project_access")) {
    const p = AUDIT_REASON_JA.project_access;
    return { kind: p.kind, reasonCode: opaque, reasonJa: p.ja };
  }
  if (opaque) return { kind: fallbackKind, reasonCode: opaque, reasonJa: `理由コード: ${opaque}` };
  return { kind: fallbackKind, reasonCode: null, reasonJa: "理由コード: 不明" };
}

function actionKind(action: string): AuditResultKind | null {
  if (
    action.endsWith(".denied") ||
    action.endsWith(".refused") ||
    action.includes("egress_denied") ||
    action.endsWith(".blocked")
  ) {
    return "denied";
  }
  if (action.endsWith(".failed") || action.endsWith(".apply_failed")) return "failure";
  if (
    action.endsWith(".posted") ||
    action.endsWith(".sent") ||
    action === "comm.delete.succeeded" ||
    action === "setup.tool_succeeded" ||
    action === "approval.resolved"
  ) {
    return "success";
  }
  if (
    action === "approval.requested" ||
    action === "approval.revision_requested" ||
    action === "topic_gate.triggered"
  ) {
    return "pending";
  }
  if (action === "approval.expired" || action === "approval.cancelled_by_plan_change") {
    return "denied";
  }
  return null;
}

export function classifyAuditResult(event: Pick<AuditEvent, "action" | "metadata">): AuditResultView {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const action = String(event.action ?? "");
  const decision = asString(meta.decision);
  const code = metaCode(meta) ?? (decision ? decision : null) ?? ACTION_REASON[action] ?? null;

  if (decision === "rejected") return reasonView("rejected", "denied");
  if (decision === "expired") return reasonView("expired", "denied");
  if (decision === "revision_requested") return reasonView("revision_requested", "pending");
  if (decision === "approved" && action === "approval.resolved") {
    return reasonView("approved", "success");
  }

  const fromAction = actionKind(action);
  if (code && AUDIT_REASON_JA[code]) return reasonView(code, fromAction ?? AUDIT_REASON_JA[code].kind);
  if (code && fromAction) return reasonView(code, fromAction);
  if (fromAction) return reasonView(code, fromAction);

  if (meta.sent === true) return reasonView(code, "success");
  if (meta.sent === false) {
    const denied = code && AUDIT_REASON_JA[code]?.kind === "denied";
    return reasonView(code, denied ? "denied" : "failure");
  }
  if (meta.auto === true && !code) return { kind: "success", reasonCode: null, reasonJa: null };

  return reasonView(code, "unknown");
}
