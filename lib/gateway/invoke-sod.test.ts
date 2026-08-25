import { describe, expect, test } from "bun:test";
import { runGatewayInvoke } from "@/lib/gateway/invoke";

describe("Gateway SoD integration", () => {
  test("a mixed-domain employee cannot auto-run mail.draft", async () => {
    const result = await runGatewayInvoke({
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      body: {
        tool: "mail.draft",
        purpose: "sales.outreach",
        jobId: `job_sod_${Date.now()}`,
      },
    });

    expect(result.httpStatus).toBe(402);
    expect(result.body.needs_approval).toBe(true);
    expect(result.body.risk).toBe("high");
    expect(String(result.body.summary)).toContain("権限混在社員");
  });
});
