import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  LINE_WEB_ONLY_HIGH_RISK,
  lineWebOnlyHighRiskVerdict,
} from "@/lib/comm/line-web-only-high-risk";
import { LINE_WEB_ONLY_APPROVE_JA } from "@/lib/comm/line-poc-copy";

describe("LINE web-only high-risk (until passkeys)", () => {
  test("catalog lists hold / money / secrets / policy / always_human", () => {
    const cats = new Set(LINE_WEB_ONLY_HIGH_RISK.map((x) => x.category));
    expect(cats.has("停止解除")).toBe(true);
    expect(cats.has("金銭")).toBe(true);
    expect(cats.has("秘密（資格情報）")).toBe(true);
    expect(cats.has("ポリシー変更")).toBe(true);
    expect(cats.has("always_human")).toBe(true);
    expect(LINE_WEB_ONLY_HIGH_RISK.every((x) => x.lineCanApprove === false)).toBe(true);
  });

  test("fail-first: money / credential / policy / always_human / unknown are refused", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "commerce.order", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "employees.credential.reissue", metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "policy.patch", metadata: { adminTool: "policy.patch" } }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalPolicy: "always_human" } }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: null, metadata: {} }).refuse).toBe(true);
    expect(lineWebOnlyHighRiskVerdict({ tool: "employee.hold.release", metadata: {} }).refuse).toBe(true);
  });

  test("classifiable non-high-risk tickets can stay on LINE", () => {
    expect(lineWebOnlyHighRiskVerdict({ tool: "comm.reply", metadata: { approvalPolicy: "risk_based" } }).refuse).toBe(false);
  });

  test("refuse copy points at the web approvals page", () => {
    expect(LINE_WEB_ONLY_APPROVE_JA).toContain("Web で承認してください");
    expect(LINE_WEB_ONLY_APPROVE_JA).toContain("/app/approvals");
  });

  test("LINE postback and workflow refuse before approve", () => {
    const events = readFileSync(join(process.cwd(), "lib/line/approval-events.ts"), "utf8");
    expect(events).toContain("lineWebOnlyHighRiskVerdict");
    expect(events).toContain("LINE_WEB_ONLY_APPROVE_JA");
    expect(events).toContain("line.web_only_refused");
    const wf = readFileSync(join(process.cwd(), "lib/approvals/workflow-integration.ts"), "utf8");
    expect(wf).toContain("lineWebOnlyHighRiskVerdict");
    expect(wf).toContain("isLineSurfaceApproval");
  });
});
