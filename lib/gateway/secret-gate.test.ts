import { describe, test, expect } from "bun:test";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { DEMO_ORG } from "@/lib/demo-data";

const DEMO_EMPLOYEE = "emp_sales";

describe("gateway secret-in-chat detector (P0-A)", () => {

  test("rejects payload with Slack bot token", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "slack.post",
        purpose: "test",
        jobId: "job_001",
        args: {
          message: "Here is the token: xoxb-123456789012-1234567890123-abcdefghij",
        },
      },
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.nextStepJa).toContain("Staffpass");
  });

  test("rejects payload with gb_emp_ credential", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_002",
        args: {
          secret: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
        },
      },
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("staffpass_employee");
  });

  test("rejects payload with gb_adm_ credential", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_003",
        args: {
          adminToken: "gb_adm_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
        },
      },
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("staffpass_admin");
  });

  test("rejects payload with OpenAI API key", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_004",
        args: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
        },
      },
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
  });

  test("rejects payload with JWT token", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_005",
        args: {
          token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        },
      },
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("jwt_token");
  });

  test("allows clean payloads without secrets", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_clean",
        args: {
          message: "Hello, this is a normal message.",
          email: "user@example.com",
        },
      },
    });

    expect(result.body.code).not.toBe("secret_detected_in_payload");
  });

  test("redactedPreview does not expose full secret", async () => {
    const fullSecret = "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab";
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_redact",
        args: {
          credential: fullSecret,
        },
      },
    });

    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("secret_detected_in_payload");
    const preview = String(result.body.redactedPreview || "");
    expect(preview.length).toBeLessThan(fullSecret.length);
    expect(preview).toContain("***");
    expect(preview).not.toBe(fullSecret);
  });

  test("nextStepJa points to Staffpass hosted setup, not chat paste", async () => {
    const result = await runGatewayInvoke({
      employeeId: DEMO_EMPLOYEE,
      body: {
        tool: "tools.ping",
        purpose: "test",
        jobId: "job_nextstep",
        args: {
          secret: "xoxb-123456789012-1234567890123-abcdefghij",
        },
      },
    });

    expect(result.body.ok).toBe(false);
    const nextStepJa = String(result.body.nextStepJa || "");
    expect(nextStepJa).toContain("Staffpass");
    expect(nextStepJa).not.toContain("貼り直");
    expect(nextStepJa).not.toContain("paste");
  });
});
