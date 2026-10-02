/**
 * P1 Channel Scope — CS6 dashboard card helpers (pure; shared by the client card and tests).
 * The card only READS (/api/channel-scope GET) and FILES change requests (PATCH → always_human
 * ticket). It never writes a policy itself.
 */
import type { ChannelScopeMode, ChannelScopeSource } from "./types";

export type ChannelScopeFormState = {
  /** "" = tenant default */
  employeeId: string;
  mode: ChannelScopeMode;
  includeSlackConnect: boolean;
  clearOverride: boolean;
};

export function channelScopeModeLabelJa(mode: ChannelScopeMode | null | undefined, includeSlackConnect = false): string {
  if (mode === "all_joined") return includeSlackConnect ? "参加中すべて＋Slack Connect" : "参加中すべて（社内のみ）";
  return "登録済みのみ";
}

export function channelScopeSourceLabelJa(source: ChannelScopeSource | string | null | undefined): string {
  if (source === "employee") return "AI社員ごとの上書き";
  if (source === "org") return "テナント既定";
  return "未設定（既定: 登録済みのみ）";
}

/** Request body for PATCH /api/channel-scope. includeSlackConnect only with all_joined + Connect flag. */
export function buildChannelScopePatchBody(
  form: ChannelScopeFormState,
  opts: { beforeStateHash: string | null; connectEnabled: boolean }
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.employeeId) body.employeeId = form.employeeId;
  if (opts.beforeStateHash) body.beforeStateHash = opts.beforeStateHash;
  if (form.employeeId && form.clearOverride) {
    body.clearOverride = true;
    return body;
  }
  body.mode = form.mode;
  if (form.mode === "all_joined" && opts.connectEnabled && form.includeSlackConnect) body.includeSlackConnect = true;
  return body;
}

const ERROR_JA: Record<string, string> = {
  feature_disabled: "チャンネル範囲設定は現在無効です（P1_CHANNEL_SCOPE_ENABLED）",
  connect_disabled: "Slack Connect を含める設定は現在無効です（P1_CHANNEL_SCOPE_CONNECT_ENABLED）",
  before_state_mismatch: "設定が他の操作で変更されました。再読み込みしてからやり直してください",
  no_change: "変更はありません",
  validation_failed: "入力内容を確認してください",
  owner_or_admin_required: "オーナーまたは管理者のみ申請できます",
  employee_not_found: "AI社員が見つかりません",
};

export function channelScopeErrorJa(body: { error?: unknown; message?: unknown } | null | undefined): string {
  const code = typeof body?.error === "string" ? body.error : "";
  if (ERROR_JA[code]) return ERROR_JA[code];
  return typeof body?.message === "string" && body.message ? body.message : "申請に失敗しました";
}
