import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HOLD_RELEASE_TOOL } from "@/lib/safety/hold-config";
import {
  HOLD_RELEASE_APPROVE_PATH,
  HOLD_RELEASE_WEB_ONLY_MESSAGE_JA,
  approvalDecideErrorJa,
  approvalDecideFailed,
  holdReleaseApproveTarget,
  holdReleaseHoldId,
} from "@/lib/approvals/hold-release-web";

const HOLD_ID = "d53e1f69-d7bb-48a5-9b6c-f4440ad93025";
const releaseTicket = {
  tool: HOLD_RELEASE_TOOL,
  metadata: { adminTool: HOLD_RELEASE_TOOL, holdId: HOLD_ID },
};
const genericTicket = {
  tool: "comm.reply",
  metadata: { holdId: HOLD_ID },
};

describe("holdReleaseApproveTarget: /app/approvals の承認は解除専用経路へ", () => {
  test("hold.release の承認だけ /api/holds/release/approve に holdId を渡す", () => {
    expect(holdReleaseApproveTarget(releaseTicket, "approve")).toEqual({
      kind: "hold_release",
      path: HOLD_RELEASE_APPROVE_PATH,
      holdId: HOLD_ID,
    });
    expect(holdReleaseApproveTarget(releaseTicket, "reject")).toEqual({ kind: "generic" });
    expect(holdReleaseApproveTarget(genericTicket, "approve")).toEqual({ kind: "generic" });
  });

  test("holdId が無い／不正なら専用経路に進まない（汎用承認にも落とさない）", () => {
    expect(holdReleaseApproveTarget({ tool: HOLD_RELEASE_TOOL, metadata: {} }, "approve")).toEqual({
      kind: "hold_release_missing_hold",
    });
    expect(holdReleaseHoldId({ metadata: { holdId: "not a hold" } })).toBe("");
    expect(holdReleaseHoldId({ metadata: { holdId: "" } })).toBe("");
    expect(holdReleaseHoldId({ metadata: { holdId: HOLD_ID } })).toBe(HOLD_ID);
  });
});

describe("approvalDecideErrorJa: エラーは日本語で画面に出す", () => {
  test("messageJa / 日本語 message / 既知コードの順で表示する", () => {
    expect(approvalDecideErrorJa({ messageJa: "専用の日本語", error: "fresh_login_required" })).toBe("専用の日本語");
    expect(approvalDecideErrorJa({ message: "解除にはログインし直してください。", error: "x" }))
      .toBe("解除にはログインし直してください。");
    expect(approvalDecideErrorJa({ error: "hold_release_web_only" })).toBe(HOLD_RELEASE_WEB_ONLY_MESSAGE_JA);
    expect(approvalDecideErrorJa({ reason: "fresh_login_required" })).toContain("5分以内");
    expect(approvalDecideErrorJa({ error: "self_approval_denied" })).toContain("本人は承認できません");
    expect(approvalDecideErrorJa({})).toBe("操作に失敗しました。");
  });

  test("HTTP 200 + ok:false も失敗（握りつぶさない）", () => {
    expect(approvalDecideFailed(true, { ok: false })).toBe(true);
    expect(approvalDecideFailed(true, { ok: true })).toBe(false);
    expect(approvalDecideFailed(false, { ok: true })).toBe(true);
    expect(approvalDecideFailed(true, {})).toBe(false);
  });
});

describe("ApprovalsClient / generic approve route が専用経路と日本語エラーを使う", () => {
  test("ApprovalsClient は hold.release 承認を専用 API に送り、ok:false を表示する", () => {
    const src = readFileSync(new URL("../../components/ApprovalsClient.tsx", import.meta.url), "utf8");
    expect(src).toContain("holdReleaseApproveTarget");
    expect(src).toContain("approvalDecideErrorJa");
    expect(src).toContain("approvalDecideFailed");
    expect(src).toContain("HOLD_RELEASE_APPROVE_PATH");
    expect(src).toContain('"content-type": "application/json"');
    expect(src).toContain("holdId: target.holdId");
    expect(src).not.toMatch(/decide\(a\.id, "approve"\)/);
  });

  test("汎用 approve ルートは hold_release_web_only を 403 + 日本語で返す", () => {
    const src = readFileSync(new URL("../../app/api/approvals/[id]/approve/route.ts", import.meta.url), "utf8");
    expect(src).toContain("hold_release_web_only");
    expect(src).toContain("HOLD_RELEASE_WEB_ONLY_MESSAGE_JA");
    expect(src).toContain("status: 403");
  });
});
