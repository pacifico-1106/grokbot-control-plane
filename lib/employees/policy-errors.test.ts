import { describe, expect, test } from "bun:test";
import {
  POLICY_ERROR_MESSAGES,
  looksJapanese,
  policyErrorMessage,
  policyErrorPayload,
} from "./policy-errors";

describe("policyErrorMessage", () => {
  test("uses Japanese message when the API already sent one", () => {
    expect(
      policyErrorMessage({
        error: "sod_ack_required",
        message: "警告を確認してから保存してください",
      })
    ).toBe("警告を確認してから保存してください");
  });

  test("maps sod_ack_required when message is missing", () => {
    expect(policyErrorMessage({ error: "sod_ack_required" })).toBe(
      POLICY_ERROR_MESSAGES.sod_ack_required
    );
    expect(looksJapanese(policyErrorMessage({ error: "sod_ack_required" }))).toBe(true);
  });

  test("maps other known codes", () => {
    expect(policyErrorMessage({ error: "allowed_accounts_required" })).toBe(
      "ブラウザ利用には許可アカウントが必要です"
    );
    expect(policyErrorMessage({ error: "invalid_policy" })).toBe(
      "権限の内容が正しくありません"
    );
    expect(policyErrorMessage({ error: "employee_not_found" })).toBe(
      "AI社員が見つかりません"
    );
    expect(policyErrorMessage({ error: "employee_terminated" })).toBe(
      "契約終了済みのAI社員は更新できません"
    );
    expect(policyErrorMessage({ error: "auth_required" })).toBe("ログインが必要です");
    expect(policyErrorMessage({ error: "invalid_identity" })).toBe(
      "表示名または職務ラベルが正しくありません"
    );
    expect(policyErrorMessage({ error: "connect_cannot_be_internal" })).toBe(
      "Slack Connect / 社外混在は社内にできません"
    );
    expect(policyErrorMessage({ error: "slack_identity_unbound" })).toBe(
      "本人として出すには、社員証で Slack 連携が必要です"
    );
    expect(policyErrorMessage({ error: "interpret_failed" })).toBe(
      "職務の読み取りに失敗しました"
    );
    expect(policyErrorMessage({ error: "issue_failed" })).toBe(
      "社員証の発行に失敗しました"
    );
  });

  test("falls back when code and message are missing", () => {
    expect(policyErrorMessage({})).toBe("保存に失敗しました");
    expect(policyErrorMessage({ error: "totally_unknown" })).toBe("保存に失敗しました");
    expect(policyErrorMessage(null)).toBe("保存に失敗しました");
  });

  test("English message does not win over a mapped code", () => {
    expect(
      policyErrorMessage({ error: "sod_ack_required", message: "SoD ack required" })
    ).toBe(POLICY_ERROR_MESSAGES.sod_ack_required);
  });
});

describe("policyErrorPayload", () => {
  test("keeps the error code and fills Japanese message", () => {
    expect(policyErrorPayload("sod_ack_required")).toEqual({
      error: "sod_ack_required",
      message: "警告を確認してから保存してください",
    });
  });
});
