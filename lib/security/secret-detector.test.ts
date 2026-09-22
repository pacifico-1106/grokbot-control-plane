import { describe, test, expect } from "bun:test";
import {
  detectSecretInString,
  detectSecretInPayload,
  redactPayloadForAudit,
  buildSecretDetectionErrorResponse,
  type SecretDetectionResult,
} from "./secret-detector";

describe("secret-detector", () => {
  describe("detectSecretInString", () => {
    test("passes normal text", () => {
      expect(detectSecretInString("Hello world")).toEqual({ ok: true });
      expect(detectSecretInString("予定を確認してください")).toEqual({ ok: true });
      expect(detectSecretInString("sales@example.com")).toEqual({ ok: true });
    });

    test("passes URLs", () => {
      expect(detectSecretInString("https://staffpass.sealith.com/app/setup")).toEqual({ ok: true });
      expect(detectSecretInString("http://localhost:3000")).toEqual({ ok: true });
    });

    test("passes short codes and dates", () => {
      expect(detectSecretInString("ABC123")).toEqual({ ok: true });
      expect(detectSecretInString("2026-09-22")).toEqual({ ok: true });
    });

    test("detects Slack xox tokens", () => {
      const result = detectSecretInString("xoxb-123456789-abcdefghij");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("slack_token");
        expect(result.code).toBe("secret_detected_in_payload");
      }
    });

    test("detects Slack xoxp tokens", () => {
      const result = detectSecretInString("xoxp-123456789-abcdefghij-xyz");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("slack_token");
      }
    });

    test("detects OpenAI sk- keys", () => {
      const result = detectSecretInString("sk-abcdefghijklmnopqrstuvwx");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("openai_key");
      }
    });

    test("detects OpenAI sk-proj keys", () => {
      const result = detectSecretInString("sk-proj-abc123def456_ghi789jkl012-xyz");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("openai_proj");
      }
    });

    test("detects Staffpass employee credentials gb_emp_", () => {
      const result = detectSecretInString("gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("staffpass_employee");
        expect(result.redactedPreview).toBe("gb_emp_1***");
      }
    });

    test("detects Staffpass admin credentials gb_adm_", () => {
      const result = detectSecretInString("gb_adm_1234567890abcdef_abcdef1234567890abcdef1234567890ab");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("staffpass_admin");
        expect(result.redactedPreview).toBe("gb_adm_1***");
      }
    });

    test("detects Stripe live API keys", () => {
      // Pattern test: sk_live_ followed by 24+ alphanumeric chars
      const testValue = "sk_" + "live" + "_" + "x".repeat(30);
      const result = detectSecretInString(testValue);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("stripe_key");
      }
    });

    test("detects Stripe test API keys", () => {
      // Pattern test: sk_test_ followed by 24+ alphanumeric chars
      const testValue = "sk_" + "test" + "_" + "x".repeat(30);
      const result = detectSecretInString(testValue);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("stripe_key");
      }
    });

    test("detects GitHub tokens", () => {
      const result = detectSecretInString("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // May match github_token or github_classic depending on pattern order
        expect(["github_token", "github_classic"]).toContain(result.pattern);
      }
    });

    test("detects AWS access keys", () => {
      const result = detectSecretInString("AKIAIOSFODNN7EXAMPLE");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("aws_access_key");
      }
    });

    test("detects JWT tokens", () => {
      const result = detectSecretInString("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("jwt_token");
      }
    });

    test("detects private key headers", () => {
      const result = detectSecretInString("-----BEGIN PRIVATE KEY-----");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("private_key_header");
      }
    });

    test("detects Bearer tokens", () => {
      const result = detectSecretInString("Bearer abcdefghijklmnopqrstuvwxyz1234567890");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("bearer_token");
      }
    });

    test("detects inline api_key assignments", () => {
      const result = detectSecretInString('api_key: "abcdefghijklmnopqrstuvwxyz"');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("api_key_inline");
      }
    });

    test("detects inline password assignments", () => {
      const result = detectSecretInString('password: "supersecretpassword123"');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("password_inline");
      }
    });

    test("nextStepJa points to Staffpass hosted setup", () => {
      const result = detectSecretInString("xoxb-123456789-abcdefghij");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.nextStepJa).toContain("Staffpass");
        expect(result.nextStepJa).not.toContain("チャットに貼");
      }
    });
  });

  describe("detectSecretInPayload", () => {
    test("passes clean payloads", () => {
      const payload = {
        tool: "calendar.propose",
        purpose: "meeting",
        jobId: "job123",
        args: {
          title: "Meeting with client",
          description: "Discuss project timeline",
        },
      };
      expect(detectSecretInPayload(payload)).toEqual({ ok: true });
    });

    test("detects secrets in nested args", () => {
      const payload = {
        tool: "slack.post",
        args: {
          message: "Here is the token: xoxb-123456789-abcdefghij",
        },
      };
      const result = detectSecretInPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("slack_token");
      }
    });

    test("detects secrets in deeply nested objects", () => {
      const payload = {
        level1: {
          level2: {
            level3: {
              secret: "sk-abcdefghijklmnopqrstuvwx",
            },
          },
        },
      };
      const result = detectSecretInPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("openai_key");
      }
    });

    test("detects secrets in arrays", () => {
      const payload = {
        messages: [
          "Hello",
          "Here is my key: gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab",
          "Goodbye",
        ],
      };
      const result = detectSecretInPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.pattern).toBe("staffpass_employee");
      }
    });
  });

  describe("redactPayloadForAudit", () => {
    test("returns safe payload when no secrets", () => {
      const payload = { tool: "ping", args: {} };
      const result = redactPayloadForAudit(payload);
      expect(result.safe).toBe(true);
      if (result.safe) {
        expect(result.payload).toEqual(payload);
      }
    });

    test("returns redacted info when secrets detected", () => {
      const payload = { 
        botToken: "xoxb-123456789-abcdefghij",
      };
      const result = redactPayloadForAudit(payload);
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.pattern).toBe("slack_token");
        expect(result.redactedPreview).not.toContain("abcdefghij");
      }
    });
  });

  describe("buildSecretDetectionErrorResponse", () => {
    test("builds proper error response", () => {
      const detection: SecretDetectionResult & { ok: false } = {
        ok: false,
        code: "secret_detected_in_payload",
        pattern: "slack_token",
        redactedPreview: "xoxb-123***",
        messageJa: "test",
        nextStepJa: "test",
      };
      const response = buildSecretDetectionErrorResponse(detection);
      expect(response.ok).toBe(false);
      expect(response.code).toBe("secret_detected_in_payload");
      expect(response.pattern).toBe("slack_token");
      expect(response.nextStepJa).toContain("Staffpass");
      expect(response.messageJa).not.toContain("貼り直");
    });
  });

  describe("prefix-only display OK", () => {
    test("redactedPreview shows only prefix", () => {
      const result = detectSecretInString("gb_emp_1234567890abcdef_abcdef1234567890abcdef1234567890ab");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.redactedPreview.length).toBeLessThan(20);
        expect(result.redactedPreview).toContain("***");
        expect(result.redactedPreview).not.toContain("abcdef1234567890");
      }
    });
  });

  describe("false positive avoidance", () => {
    test("does not flag normal employee IDs", () => {
      expect(detectSecretInString("emp_sales")).toEqual({ ok: true });
      expect(detectSecretInString("emp_accounting")).toEqual({ ok: true });
    });

    test("does not flag approval IDs", () => {
      expect(detectSecretInString("appr_123abc")).toEqual({ ok: true });
    });

    test("does not flag org IDs", () => {
      expect(detectSecretInString("org_sample_shoji")).toEqual({ ok: true });
    });

    test("does not flag channel IDs", () => {
      expect(detectSecretInString("C1234567890")).toEqual({ ok: true });
      expect(detectSecretInString("D9876543210")).toEqual({ ok: true });
    });

    test("does not flag user IDs", () => {
      expect(detectSecretInString("U1234567890")).toEqual({ ok: true });
    });

    test("does not flag timestamps", () => {
      expect(detectSecretInString("1695384000.123456")).toEqual({ ok: true });
    });

    test("does not flag ISO dates", () => {
      expect(detectSecretInString("2026-09-22T10:30:00Z")).toEqual({ ok: true });
    });

    test("does not flag email addresses", () => {
      expect(detectSecretInString("admin@example.com")).toEqual({ ok: true });
    });
  });
});
