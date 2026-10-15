import { describe, expect, test } from "bun:test";
import { classifyAuditResult } from "./result";

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
