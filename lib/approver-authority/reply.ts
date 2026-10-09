/**
 * PR-D: approver-authority replies / nextSteps / 事後通知 text. Dependency-free
 * (type imports only) so webhook routes can import it without pulling in the
 * flag or data modules.
 */
import type { ApproverAuthorityResultReason } from "./decide";

function isReason(reason: unknown): reason is ApproverAuthorityResultReason {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON_JA, reason);
}

const REASON_JA: Record<ApproverAuthorityResultReason, string> = {
  owner_approval_required:
    "指定管理者の承認を記録しました。この変更はオーナーの承認が必要なため、オーナー承認待ちのままです（まだ反映していません）。",
  invalid_required_kind: "承認者の条件を確認できないため止めました。",
  org_has_no_owner: "組織に有効なオーナーがいないため、この変更は承認できません。",
  approver_member_required: "承認者として登録されたメンバーを確認できないため、承認できません。承認者バインディングを確認してください。",
  approver_not_found: "承認者として登録されたメンバーを確認できないため、承認できません。",
  approver_inactive: "無効なメンバーは承認できません。",
  approver_not_authorized: "この変更を承認できるのはオーナーまたは指定管理者だけです。",
  approver_unverified: "承認者を確認できなかったため止めました。時間をおいて再度お試しください。",
  no_owner_other_than_requester:
    "オーナーが複数いるときは申請者本人の承認では立ちませんが、申請者以外に承認できるオーナーがいないため止めました。",
  approver_is_requester: "申請者は自分の申請を承認できません。申請者以外のオーナーが承認してください。",
  approver_identity_unverified:
    "押した方の Slack / LINE / Telegram アカウントが、承認できるメンバー本人に紐づいていることを確認できないため止めました。",
  approver_is_target: "オーナーに追加される本人は、この申請を承認できません。",
  approver_class_missing:
    "この申請は承認者チェックを有効にする前に出されたもので、誰が承認できるかの条件が記録されていないため実行しませんでした。",
};

/** What to do next, for reasons where the person can act. */
const NEXT_STEP_JA: Partial<Record<ApproverAuthorityResultReason, string>> = {
  org_has_no_owner: "組織に有効なオーナーを設定してから、もう一度申請してください。",
  no_owner_other_than_requester:
    "申請者以外のオーナーに承認を依頼してください（オーナーが複数いる場合は、申請者以外のいずれか1人の承認で足ります）。",
  approver_is_requester: "申請者以外のオーナー（または、標準の変更なら指定管理者）に承認を依頼してください。",
  approver_not_authorized: "オーナーまたは指定管理者に承認を依頼してください。",
  approver_identity_unverified: "承認者登録（approvalWorkflow.bindVoter）で、このアカウントをご本人のメンバーに紐づけてから押してください。",
  approver_is_target: "対象者と申請者以外の既存オーナーに承認を依頼してください。",
  approver_class_missing: "同じ内容でもう一度申請してください（新しい申請にはオーナーまたは指定管理者の承認条件が付きます）。",
};

/** nextStep for the reply / API response; null when there is nothing specific to do. */
export function approverAuthorityNextStepJa(reason: unknown): string | null {
  return isReason(reason) ? NEXT_STEP_JA[reason] ?? null : null;
}

/** Reply for the person who pressed approve (+ 次の手順 when there is one); null when the reason is not ours. */
export function approverAuthorityReplyJa(reason: unknown): string | null {
  if (!isReason(reason)) return null;
  const next = NEXT_STEP_JA[reason];
  return next ? `${REASON_JA[reason]}\n次の手順: ${next}` : REASON_JA[reason];
}

/**
 * 事後通知 to the other owners once an approver-authority ticket is approved.
 * Carries only the tool id, a short ticket id and who approved (role + display
 * name) — never the title, summary, arguments or any secret.
 */
export function approverAuthorityApprovedNoticeJa(input: {
  tool: string | null | undefined;
  approvalId: string;
  approverRole: "owner" | "designated_admin" | null | undefined;
  approverDisplayName?: string | null;
}): string {
  const role = input.approverRole === "owner" ? "オーナー" : input.approverRole === "designated_admin" ? "指定管理者" : "承認者";
  const name = String(input.approverDisplayName || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  const tool = String(input.tool || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80) || "(不明な操作)";
  return [
    "✅ 承認されました（事後通知）",
    `対象: ${tool}（申請 #${String(input.approvalId).slice(0, 8)}）`,
    `承認者: ${name ? `${name}（${role}）` : role}`,
    "詳細は管理画面の承認履歴で確認してください。",
  ].join("\n");
}

/** members.promoteOwner applied — names + short ticket id only (no args / secrets). */
export function ownerPromotedNoticeJa(input: {
  approvalId: string;
  targetDisplayName?: string | null;
  approverDisplayName?: string | null;
}): string {
  const clean = (v: string | null | undefined) => String(v || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  const target = clean(input.targetDisplayName) || "(名前なし)";
  const approver = clean(input.approverDisplayName);
  return [
    "👑 オーナーを追加しました",
    `新しいオーナー: ${target}`,
    `承認: ${approver ? `${approver}（オーナー）` : "オーナー"}（申請 #${String(input.approvalId).slice(0, 8)}）`,
    "オーナー標準の権限が付きました。心当たりがない場合は管理画面のチーム設定と監査ログを確認してください。",
  ].join("\n");
}
