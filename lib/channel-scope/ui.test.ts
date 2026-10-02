import { describe, expect, test } from "bun:test";
import { buildChannelScopePatchBody, channelScopeErrorJa, channelScopeModeLabelJa, channelScopeSourceLabelJa } from "./ui";

describe("dashboard card helpers", () => {
  test("labels", () => {
    expect(channelScopeModeLabelJa("registered_only")).toBe("登録済みのみ");
    expect(channelScopeModeLabelJa("all_joined")).toBe("参加中すべて（社内のみ）");
    expect(channelScopeModeLabelJa("all_joined", true)).toBe("参加中すべて＋Slack Connect");
    expect(channelScopeSourceLabelJa("default")).toContain("未設定");
    expect(channelScopeSourceLabelJa("employee")).toContain("上書き");
  });

  test("patch body: tenant default, employee override, clear, Connect only with flag + all_joined", () => {
    const base = { employeeId: "", mode: "all_joined" as const, includeSlackConnect: true, clearOverride: false };
    expect(buildChannelScopePatchBody(base, { beforeStateHash: "h1", connectEnabled: false })).toEqual({ mode: "all_joined", beforeStateHash: "h1" });
    expect(buildChannelScopePatchBody(base, { beforeStateHash: "h1", connectEnabled: true })).toEqual({
      mode: "all_joined",
      includeSlackConnect: true,
      beforeStateHash: "h1",
    });
    expect(buildChannelScopePatchBody({ ...base, mode: "registered_only" }, { beforeStateHash: null, connectEnabled: true })).toEqual({
      mode: "registered_only",
    });
    expect(buildChannelScopePatchBody({ ...base, employeeId: "emp_1", clearOverride: true }, { beforeStateHash: "h2", connectEnabled: true })).toEqual({
      employeeId: "emp_1",
      beforeStateHash: "h2",
      clearOverride: true,
    });
    // The card never sends approvalId / jobId (the Web API rejects them).
    const body = buildChannelScopePatchBody(base, { beforeStateHash: "h", connectEnabled: true });
    expect("approvalId" in body || "jobId" in body).toBe(false);
  });

  test("error messages", () => {
    expect(channelScopeErrorJa({ error: "before_state_mismatch" })).toContain("再読み込み");
    expect(channelScopeErrorJa({ error: "x", message: "サーバー" })).toBe("サーバー");
    expect(channelScopeErrorJa(null)).toBe("申請に失敗しました");
  });
});
