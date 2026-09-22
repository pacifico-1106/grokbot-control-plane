import { describe, test, expect } from "bun:test";
import {
  validateEmployeeMcpResponse,
  validateAdminMcpResponse,
  sanitizeSecretForDisplay,
  isSecretPrefix,
  assertNoFullSecretInEmployeeMcp,
  assertNoUnauthorizedSecretInAdminMcp,
  MCP_RESPONSE_CONTRACT_RULES,
} from "./mcp-response-contract";

describe("mcp-response-contract", () => {
  describe("validateEmployeeMcpResponse", () => {
    test("passes clean whoami response", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        displayName: "営業AI",
        orgId: "org_sample_shoji",
        status: "active",
        bindingStatus: "linked",
        scopes: ["tools:read", "mail:draft"],
      };
      expect(validateEmployeeMcpResponse(response)).toEqual({ ok: true });
    });

    test("passes response with secretPrefix (short)", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        secretPrefix: "gb_emp_1234***",
      };
      expect(validateEmployeeMcpResponse(response)).toEqual({ ok: true });
    });

    test("rejects response with full gb_emp_ secret", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        credential: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
      };
      const result = validateEmployeeMcpResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("secret_in_mcp_response");
        expect(result.pattern).toBe("credential");
      }
    });

    test("rejects response with full gb_adm_ secret", () => {
      const response = {
        ok: true,
        adminSecret: "gb_adm_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
      };
      const result = validateEmployeeMcpResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("secret_in_mcp_response");
        expect(result.pattern).toBe("adminSecret");
      }
    });

    test("rejects response with Slack token", () => {
      // Use obviously fake test value (suffix too short for real tokens)
      const response = {
        slackConfig: {
          botToken: "xoxb-000000000000-0000000000000-fakefakefake",
        },
      };
      const result = validateEmployeeMcpResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("slackConfig.botToken");
      }
    });

    test("rejects response with nested secrets", () => {
      const response = {
        level1: {
          level2: {
            level3: {
              secret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
            },
          },
        },
      };
      const result = validateEmployeeMcpResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("level1.level2.level3.secret");
      }
    });

    test("rejects response with secret in array", () => {
      const response = {
        credentials: [
          { id: "cred1", token: "normal" },
          { id: "cred2", token: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab" },
        ],
      };
      const result = validateEmployeeMcpResponse(response);
      expect(result.ok).toBe(false);
    });
  });

  describe("validateAdminMcpResponse", () => {
    test("passes clean admin response", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        tool: "employees.issue",
        secretPrefix: "gb_emp_1234",
      };
      expect(validateAdminMcpResponse(response)).toEqual({ ok: true });
    });

    test("passes response with oneTimeSecret when allowed", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        oneTimeSecret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
        secretPrefix: "gb_emp_1234",
      };
      expect(validateAdminMcpResponse(response, { allowOneTimeSecret: true })).toEqual({ ok: true });
    });

    test("rejects oneTimeSecret when not allowed", () => {
      const response = {
        ok: true,
        employeeId: "emp_sales",
        oneTimeSecret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
      };
      const result = validateAdminMcpResponse(response, { allowOneTimeSecret: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("oneTimeSecret");
      }
    });

    test("rejects secret in non-oneTimeSecret field", () => {
      const response = {
        ok: true,
        rawCredential: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
      };
      const result = validateAdminMcpResponse(response, { allowOneTimeSecret: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("rawCredential");
      }
    });

    test("passes secretPrefix even when long-ish but under 14 chars", () => {
      const response = {
        ok: true,
        secretPrefix: "gb_emp_1234ab",
      };
      expect(validateAdminMcpResponse(response)).toEqual({ ok: true });
    });
  });

  describe("sanitizeSecretForDisplay", () => {
    test("truncates long secrets", () => {
      const secret = "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab";
      const result = sanitizeSecretForDisplay(secret);
      expect(result).toBe("gb_emp_1234567***");
      expect(result.length).toBe(17);
    });

    test("preserves short values", () => {
      const short = "gb_emp_12";
      const result = sanitizeSecretForDisplay(short);
      expect(result).toBe(short);
    });

    test("uses custom prefix length", () => {
      const secret = "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab";
      const result = sanitizeSecretForDisplay(secret, 8);
      expect(result).toBe("gb_emp_1***");
    });
  });

  describe("isSecretPrefix", () => {
    test("returns true for valid prefixes", () => {
      expect(isSecretPrefix("gb_emp_1234ab")).toBe(true);
      expect(isSecretPrefix("gb_adm_1234ab")).toBe(true);
      expect(isSecretPrefix("xoxb-12345678")).toBe(true);
    });

    test("returns false for full secrets", () => {
      expect(isSecretPrefix("gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab")).toBe(false);
    });

    test("returns false for other values", () => {
      expect(isSecretPrefix("normal_value")).toBe(false);
      expect(isSecretPrefix("some_long_string_that_is_not_a_secret")).toBe(false);
    });
  });

  describe("assertNoFullSecretInEmployeeMcp", () => {
    test("does not throw for clean response", () => {
      expect(() => {
        assertNoFullSecretInEmployeeMcp({
          ok: true,
          employeeId: "emp_sales",
          secretPrefix: "gb_emp_1234",
        });
      }).not.toThrow();
    });

    test("throws for response with secret", () => {
      expect(() => {
        assertNoFullSecretInEmployeeMcp({
          ok: true,
          secret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
        });
      }).toThrow(/MCP Response Contract Violation/);
    });
  });

  describe("assertNoUnauthorizedSecretInAdminMcp", () => {
    test("does not throw when oneTimeSecret is allowed", () => {
      expect(() => {
        assertNoUnauthorizedSecretInAdminMcp(
          {
            ok: true,
            oneTimeSecret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
          },
          { allowOneTimeSecret: true }
        );
      }).not.toThrow();
    });

    test("throws when oneTimeSecret is not allowed", () => {
      expect(() => {
        assertNoUnauthorizedSecretInAdminMcp(
          {
            ok: true,
            oneTimeSecret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
          },
          { allowOneTimeSecret: false }
        );
      }).toThrow(/MCP Response Contract Violation/);
    });
  });

  describe("MCP_RESPONSE_CONTRACT_RULES", () => {
    test("documents employee MCP rules", () => {
      expect(MCP_RESPONSE_CONTRACT_RULES.employeeMcp.rule).toContain("Employee MCP");
      expect(MCP_RESPONSE_CONTRACT_RULES.employeeMcp.forbidden).toContain("gb_emp_*, gb_adm_*, xox*, sk-*, トークン全文");
    });

    test("documents admin MCP rules", () => {
      expect(MCP_RESPONSE_CONTRACT_RULES.adminMcp.rule).toContain("Admin MCP");
      expect(MCP_RESPONSE_CONTRACT_RULES.adminMcp.allowed).toContain("oneTimeSecret (アトミック消費)");
    });

    test("documents chat surface rules", () => {
      expect(MCP_RESPONSE_CONTRACT_RULES.chatSurfaces.rule).toContain("チャット");
      expect(MCP_RESPONSE_CONTRACT_RULES.chatSurfaces.forbidden).toContain("パスワード");
      expect(MCP_RESPONSE_CONTRACT_RULES.chatSurfaces.forbidden).toContain("リフレッシュトークン");
    });
  });
});
