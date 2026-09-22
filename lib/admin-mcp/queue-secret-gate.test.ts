import { describe, test, expect } from "bun:test";
import { queueAdminTool, type AdminQueueSecretRejection } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent();
  return {
    orgId: DEMO_ORG.id,
    generation: agent.credentialGeneration,
    actorId: agent.id,
    fingerprint: agent.credentialFingerprint || "",
    grokBotAgentId: agent.grokBotAgentId || null,
    grokBotWorkspaceId: agent.grokBotWorkspaceId || null,
    secretPrefix: agent.secretPrefix,
    binding: agent,
  };
}

describe("admin queue secret-in-chat detector (P0-A)", () => {
  test("rejects args with Slack bot token", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.slackAdapter.setBotToken",
      args: {
        botToken: "xoxb-123456789012-1234567890123-abcdefghij",
      },
      summary: "Test with secret",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("slack_token");
    expect(rejection.nextStepJa).toContain("Staffpass");
  });

  test("rejects args with gb_emp_ credential", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "employees.issue",
      args: {
        displayName: "Test AI",
        roleLabel: "Test",
        scopes: ["tools:read"],
        credential: "gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
      },
      summary: "Test with employee secret",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("staffpass_employee");
  });

  test("rejects args with nested secrets", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "parties.upsert",
      args: {
        kind: "email_domain",
        identifier: "example.com",
        config: {
          nested: {
            apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
          },
        },
      },
      summary: "Test with nested secret",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
  });

  test("allows clean args without secrets", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "parties.upsert",
      args: {
        kind: "email_domain",
        identifier: "example.com",
        audience: "internal",
        jobId: "job_clean_test",
      },
      summary: "Clean test",
    });

    expect(result.code).toBe("needs_approval");
    expect(result.ok).toBe(false);
    expect("needs_approval" in result && result.needs_approval).toBe(true);
  });

  test("redactedPreview does not expose full secret", async () => {
    const fullSecret = "gb_adm_1234567890abcdef_abcdef1234567890abcdef1234567890ab";
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "link",
      args: {
        employeeId: "emp_test",
        adminSecret: fullSecret,
      },
      summary: "Test redaction",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.redactedPreview.length).toBeLessThan(fullSecret.length);
    expect(rejection.redactedPreview).toContain("***");
  });
});
