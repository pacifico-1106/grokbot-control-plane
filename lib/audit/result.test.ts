import { describe, expect, test } from "bun:test";
import { classifyAuditResult, mapAdminStoredResult, presentStoredSixFieldResult } from "./result";

describe("classifyAuditResult", () => {
  test("does not mix failure and denied", () => {
    expect(classifyAuditResult({ action: "slack.post_failed", metadata: {} }).kind).toBe("failure");
    expect(classifyAuditResult({ action: "action_limit.denied", metadata: {} }).kind).toBe("denied");
    expect(classifyAuditResult({ action: "slack.file_egress_denied", metadata: {} }).kind).toBe("denied");
  });

  test("unknown codes stay opaque", () => {
    const r = classifyAuditResult({ action: "tool.invoke", metadata: { code: "brand_new_code" } });
    expect(r.kind).toBe("unknown");
    expect(r.reasonJa).toBe("理由コード: brand_new_code");
    expect(r.reasonJa).not.toContain("payload");
  });

  test("free-text metadata.reason is not dumped into the view", () => {
    const r = classifyAuditResult({
      action: "tool.invoke",
      metadata: {
        reason: "sent to alice@example.com pollPath=/api/approvals/status?id=x&token=SECRETTOKEN",
      },
    });
    expect(r.reasonJa).toBe("理由コード: 不明");
    expect(r.reasonCode).toBeNull();
    expect(JSON.stringify(r)).not.toContain("alice@example.com");
    expect(JSON.stringify(r)).not.toContain("SECRETTOKEN");
    expect(JSON.stringify(r)).not.toContain("pollPath");
  });

  test("auto invoke without code is success; old rows stay unknown", () => {
    expect(classifyAuditResult({ action: "tool.invoke", metadata: { auto: true } }).kind).toBe("success");
    expect(classifyAuditResult({ action: "employee.created", metadata: {} }).kind).toBe("unknown");
  });
});

describe("stored six-field result (PR-4)", () => {
  test("maps success / denied / error / pending; unknown is null (fail-closed)", () => {
    expect(mapAdminStoredResult("success")).toBe("success");
    expect(mapAdminStoredResult("denied")).toBe("denied");
    expect(mapAdminStoredResult("error")).toBe("failure");
    expect(mapAdminStoredResult("pending")).toBe("pending");
    expect(mapAdminStoredResult("nope")).toBeNull();
    expect(mapAdminStoredResult(null)).toBeNull();
  });

  test("uses stored reason label when safe; strips PII / secrets", () => {
    const ok = presentStoredSixFieldResult({
      result: "denied",
      reason: { code: "approver_not_authorized", labelJa: "この操作を承認できる人ではありません" },
    });
    expect(ok).toEqual({
      kind: "denied",
      reasonCode: "approver_not_authorized",
      reasonJa: "この操作を承認できる人ではありません",
    });

    const dirty = presentStoredSixFieldResult({
      result: "success",
      reason: {
        code: "approved",
        labelJa: "mail alice@example.com /api/approvals/status?id=x&token=SECRETTOKEN",
      },
    });
    expect(dirty?.kind).toBe("success");
    expect(JSON.stringify(dirty)).not.toContain("alice@example.com");
    expect(JSON.stringify(dirty)).not.toContain("SECRETTOKEN");
    expect(dirty?.reasonJa).not.toContain("alice@example.com");
  });

  test("unstructured reason string is not dumped", () => {
    const r = presentStoredSixFieldResult({
      result: "denied",
      reason: "sent to alice@example.com",
    });
    expect(r?.kind).toBe("denied");
    expect(r?.reasonJa).toBeNull();
    expect(JSON.stringify(r)).not.toContain("alice@example.com");
  });
});
