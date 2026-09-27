import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { queueAdminTool, type AdminQueueSecretRejection } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG } from "@/lib/demo-data";
import { encryptNotificationSecrets } from "@/lib/notify/crypto";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
let savedEncryptionKey: string | undefined;

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

beforeEach(() => {
  savedEncryptionKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  if (savedEncryptionKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedEncryptionKey;
});

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

describe("admin queue rawArgsForSecretScan (P0-A ciphertext bypass)", () => {
  test("allows encrypted ciphertext when rawArgsForSecretScan has clean args", async () => {
    const testSecret = "test-secret-value-for-encryption-only";
    const ciphertext = encryptNotificationSecrets({ testSecret });
    expect(ciphertext.startsWith("v1.")).toBe(true);
    expect(ciphertext.length).toBeGreaterThan(40);

    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.slackAdapter.setBotToken",
      args: {
        enabled: true,
        botTokenPresent: true,
        botTokenCiphertext: ciphertext,
      },
      rawArgsForSecretScan: {
        enabled: true,
        botTokenPresent: true,
      },
      summary: "Test with encrypted token",
    });

    expect(result.code).toBe("needs_approval");
    expect(result.ok).toBe(false);
    expect("needs_approval" in result && result.needs_approval).toBe(true);
  });

  test("rejects when rawArgsForSecretScan contains a detectable secret pattern", async () => {
    const openaiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const ciphertext = encryptNotificationSecrets({ key: openaiKey });

    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.slackAdapter.setBotToken",
      args: {
        enabled: true,
        botTokenPresent: true,
        botTokenCiphertext: ciphertext,
      },
      rawArgsForSecretScan: {
        enabled: true,
        apiKey: openaiKey,
      },
      summary: "Test with secret in scan args",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("openai_key");
  });

  test("scans args when rawArgsForSecretScan is not provided", async () => {
    const ciphertext = encryptNotificationSecrets({ secret: "test" });

    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.slackAdapter.setBotToken",
      args: {
        enabled: true,
        botTokenCiphertext: ciphertext,
      },
      summary: "Test fallback to args scan",
    });

    expect(result.code).toBe("needs_approval");
    expect(result.ok).toBe(false);
  });

  test("LINE approval ciphertext does not trigger aws_secret_key pattern", async () => {
    const secrets = {
      channelAccessToken: "line-channel-access-token-test-value",
      channelSecret: "line-channel-secret-value-test-12345",
    };
    const ciphertext = encryptNotificationSecrets(secrets);
    expect(ciphertext.length).toBeGreaterThan(40);

    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.lineApproval.upsert",
      args: {
        enabled: true,
        destinationId: "Uabcdef1234567890",
        channelAccessTokenPresent: true,
        channelSecretPresent: true,
        secretsCiphertext: ciphertext,
      },
      rawArgsForSecretScan: {
        enabled: true,
        destinationId: "Uabcdef1234567890",
        channelAccessTokenPresent: true,
        channelSecretPresent: true,
      },
      summary: "Test LINE ciphertext bypass",
    });

    expect(result.code).toBe("needs_approval");
    expect(result.ok).toBe(false);
    expect("needs_approval" in result && result.needs_approval).toBe(true);
  });
});

describe("admin queue per-tool secret allowlist (P0-A narrow exclusion)", () => {
  test("botToken on non-allowlisted tool is still rejected", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "parties.upsert",
      args: {
        kind: "email_domain",
        identifier: "example.com",
        botToken: "xoxb-fake-token-for-some-reason",
      },
      summary: "Test botToken on wrong tool",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("slack_token");
  });

  test("AWS-key-like value in non-allowlisted field of setBotToken is still rejected", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "setup.slackAdapter.setBotToken",
      args: {
        enabled: true,
        botTokenPresent: true,
        metadata: {
          awsKey: "AKIAIOSFODNN7EXAMPLE",
        },
      },
      summary: "Test non-allowlisted field with secret",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("aws_access_key");
  });

  test("channelAccessToken with secret-like value on non-LINE tool is still rejected", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "channels.classify",
      args: {
        externalId: "C123456",
        classification: "internal",
        channelAccessToken: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      },
      summary: "Test secret-like token on wrong tool",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("openai_key");
  });

  test("ownerPassword with secret-like value on orgs.create is still scanned", async () => {
    const result = await queueAdminTool({
      cred: demoCred(),
      tool: "orgs.create",
      args: {
        name: "Test Org",
        ownerEmail: "owner@example.com",
        ownerPassword: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      },
      summary: "Test ownerPassword is scanned",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("secret_detected_in_payload");
    const rejection = result as AdminQueueSecretRejection;
    expect(rejection.pattern).toBe("openai_key");
  });
});
