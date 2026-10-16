/**
 * MCP_AUTH_401_NEXT_STEP_JA_ENABLED (default OFF): Japanese next-step text for
 * /api/mcp 401s. Machine-readable `data.code` stays missing_credential /
 * invalid_credential / expired. Missing/empty vs expired are distinct;
 * invalid does not say whether a matching 社員証 exists.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  isMcpAuth401NextStepJaEnabled,
  mcpAuth401NextStepJa,
  mcpAuthFailureKind,
} from "./mcp-auth-failure";

const FLAG = "MCP_AUTH_401_NEXT_STEP_JA_ENABLED";
const saved = process.env[FLAG];
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("MCP_AUTH_401_NEXT_STEP_JA_ENABLED defaults OFF", () => {
  test("unset / empty / garbage → OFF; 1/true/on/enabled → ON", () => {
    delete process.env[FLAG];
    expect(isMcpAuth401NextStepJaEnabled()).toBe(false);
    process.env[FLAG] = "";
    expect(isMcpAuth401NextStepJaEnabled()).toBe(false);
    process.env[FLAG] = "nope";
    expect(isMcpAuth401NextStepJaEnabled()).toBe(false);
    for (const v of ["1", "true", "ON", "enabled"]) {
      process.env[FLAG] = v;
      expect(isMcpAuth401NextStepJaEnabled()).toBe(true);
    }
  });
});

describe("mcpAuthFailureKind", () => {
  test("maps only the three audited 401 kinds; others are null", () => {
    expect(mcpAuthFailureKind("missing_credential")).toBe("missing_credential");
    expect(mcpAuthFailureKind("invalid_credential")).toBe("invalid");
    expect(mcpAuthFailureKind("expired")).toBe("expired");
    expect(mcpAuthFailureKind("revoked")).toBeNull();
    expect(mcpAuthFailureKind("employee_not_found")).toBeNull();
    expect(mcpAuthFailureKind("employee_on_hold")).toBeNull();
  });
});

describe("mcpAuth401NextStepJa", () => {
  test("missing_credential: 社員証が届いていない / env / 再起動。expired とは別文", () => {
    const missing = mcpAuth401NextStepJa("missing_credential");
    const expired = mcpAuth401NextStepJa("expired");
    expect(missing).toContain("届いていません");
    expect(missing).toContain("環境変数");
    expect(missing).toContain("再起動");
    expect(missing).not.toContain("期限");
    expect(expired).toContain("期限");
    expect(expired).not.toBe(missing);
  });

  test("expired: 再発行の手順（ダッシュボード）。社員IDが安全ならパスを含む", () => {
    const expired = mcpAuth401NextStepJa("expired");
    expect(expired).toContain("再発行");
    expect(expired).toContain("/app/employees");
    expect(expired).toContain("チャットに貼らない");
    const withId = mcpAuth401NextStepJa("expired", { employeeId: "emp_tomori_01" });
    expect(withId).toContain("/app/employees/emp_tomori_01");
    expect(mcpAuth401NextStepJa("expired", { employeeId: "not a path" })).not.toContain("not a path");
  });

  test("invalid: 存在有無を漏らさない。トークン・ハッシュ・プレフィックスなし", () => {
    const invalid = mcpAuth401NextStepJa("invalid_credential");
    expect(invalid).toContain("確認できませんでした");
    expect(invalid).not.toContain("期限");
    expect(invalid).not.toContain("届いていません");
    expect(invalid).not.toContain("/app/employees/");
    expect(invalid).not.toMatch(/gb_emp_[A-Za-z0-9]{8,}/);
    expect(JSON.stringify(invalid)).not.toContain("secret");
  });

  test("other codes → null (body unchanged)", () => {
    expect(mcpAuth401NextStepJa("revoked")).toBeNull();
    expect(mcpAuth401NextStepJa("employee_on_hold")).toBeNull();
  });
});
