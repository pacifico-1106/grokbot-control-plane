import { describe, expect, test } from "bun:test";
import { resolveAdminCredential, isEmployeeBadgeSecret, isAdminSecret } from "@/lib/auth/admin-credential";

describe("admin MCP auth fail-closed", () => {
  test("gb_emp_ is an employee badge and not an admin secret", () => {
    expect(isEmployeeBadgeSecret("gb_emp_abc")).toBe(true);
    expect(isAdminSecret("gb_emp_abc")).toBe(false);
    expect(isAdminSecret("gb_adm_abc")).toBe(true);
  });

  test("missing credential fails closed", async () => {
    const result = await resolveAdminCredential(new Request("https://staffpass.sealith.com/api/mcp/admin"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_credential");
  });

  test("employee badge bearer is rejected", async () => {
    const result = await resolveAdminCredential(
      new Request("https://staffpass.sealith.com/api/mcp/admin", {
        headers: { authorization: "Bearer gb_emp_not_admin" },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("employee_badge_rejected");
  });
});
