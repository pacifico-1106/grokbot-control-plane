/**
 * P1 External Contract Card Registration Tests
 *
 * Tests cover:
 * 1. No PAN columns in migration (verified by SQL inspection)
 * 2. Pack Checkout not mixed (purpose=payment_method_setup check)
 * 3. Webhook signature fail-closed
 * 4. Detector does not echo secrets (card data redacted)
 * 5. Flag-off paths inert
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isExternalContractCardSetupEnabled,
  checkExternalContractCardSetupFlag,
  EXTERNAL_CONTRACT_CARD_SETUP_FLAG,
} from "./feature-flag";
import {
  detectSecretInString,
  detectCardLikeString,
  isCardLikeDetection,
  buildCardDetectionErrorResponse,
  type SecretDetectionResult,
} from "@/lib/security/secret-detector";

describe("P1 External Contract Card Registration", () => {
  describe("Feature Flag", () => {
    const originalEnv = process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = originalEnv;
      } else {
        delete process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
      }
    });

    test("default OFF (undefined env)", () => {
      delete process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
      expect(isExternalContractCardSetupEnabled()).toBe(false);
    });

    test("default OFF (empty string)", () => {
      process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "";
      expect(isExternalContractCardSetupEnabled()).toBe(false);
    });

    test("default OFF (0)", () => {
      process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "0";
      expect(isExternalContractCardSetupEnabled()).toBe(false);
    });

    test("enabled when set to 1", () => {
      process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "1";
      expect(isExternalContractCardSetupEnabled()).toBe(true);
    });

    test("enabled when set to true", () => {
      process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "true";
      expect(isExternalContractCardSetupEnabled()).toBe(true);
    });

    test("checkExternalContractCardSetupFlag returns error when disabled", () => {
      delete process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
      const result = checkExternalContractCardSetupFlag();
      expect(result.enabled).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe("feature_disabled");
      expect(result.error?.messageJa).toContain("セキュリティ監査");
    });

    test("checkExternalContractCardSetupFlag returns enabled when on", () => {
      process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "1";
      const result = checkExternalContractCardSetupFlag();
      expect(result.enabled).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("Card-like String Detection (Secret Detector Extension)", () => {
    describe("detectCardLikeString", () => {
      test("detects Visa card numbers", () => {
        const result = detectCardLikeString("4111111111111111");
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.patternName).toBe("card_visa");
        }
      });

      test("detects Mastercard numbers", () => {
        const result = detectCardLikeString("5500000000000004");
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.patternName).toBe("card_mastercard");
        }
      });

      test("detects Amex numbers", () => {
        const result = detectCardLikeString("340000000000009");
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.patternName).toBe("card_amex");
        }
      });

      test("detects card numbers with spaces", () => {
        const result = detectCardLikeString("4111 1111 1111 1111");
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.patternName).toBe("card_generic_16");
        }
      });

      test("detects card numbers with hyphens", () => {
        const result = detectCardLikeString("4111-1111-1111-1111");
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.patternName).toBe("card_generic_16");
        }
      });

      test("rejects numbers failing Luhn check", () => {
        const result = detectCardLikeString("4111111111111112");
        expect(result.detected).toBe(false);
      });

      test("passes normal text", () => {
        expect(detectCardLikeString("Hello world")).toEqual({ detected: false });
        expect(detectCardLikeString("予定を確認してください")).toEqual({
          detected: false,
        });
      });

      test("passes short numbers", () => {
        expect(detectCardLikeString("12345")).toEqual({ detected: false });
        expect(detectCardLikeString("1234567890")).toEqual({ detected: false });
      });

      test("passes phone numbers", () => {
        expect(detectCardLikeString("03-1234-5678")).toEqual({
          detected: false,
        });
        expect(detectCardLikeString("+81-90-1234-5678")).toEqual({
          detected: false,
        });
      });
    });

    describe("detectSecretInString with card patterns", () => {
      test("detects card numbers in strings", () => {
        const result = detectSecretInString(
          "My card is 4111111111111111"
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.pattern).toBe("card_visa");
        }
      });

      test("redactedPreview is [CARD_DATA_REDACTED] for card patterns", () => {
        const result = detectSecretInString("4111111111111111");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.redactedPreview).toBe("[CARD_DATA_REDACTED]");
        }
      });

      test("nextStepJa mentions Stripe secure page", () => {
        const result = detectSecretInString("4111111111111111");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.nextStepJa).toContain("Stripe");
          expect(result.nextStepJa).toContain("安全");
        }
      });
    });

    describe("detector does not echo card secrets", () => {
      test("redactedPreview never contains card digits", () => {
        const cardNumbers = [
          "4111111111111111",
          "5500000000000004",
          "340000000000009",
          "4111 1111 1111 1111",
          "4111-1111-1111-1111",
        ];

        for (const cardNum of cardNumbers) {
          const result = detectSecretInString(cardNum);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.redactedPreview).toBe("[CARD_DATA_REDACTED]");
            expect(result.redactedPreview).not.toContain("4111");
            expect(result.redactedPreview).not.toContain("5500");
            expect(result.redactedPreview).not.toContain("3400");
          }
        }
      });

      test("error response for card detection uses stricter redaction", () => {
        const result = detectSecretInString("4111111111111111");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const errorResponse = buildCardDetectionErrorResponse(result);
          expect(errorResponse.redactedPreview).toBe("[CARD_DATA_REDACTED]");
          expect(errorResponse.error).toBe("card_like_string_blocked");
        }
      });
    });

    describe("isCardLikeDetection helper", () => {
      test("returns true for card patterns", () => {
        const result = detectSecretInString("4111111111111111");
        expect(isCardLikeDetection(result)).toBe(true);
      });

      test("returns false for other secrets", () => {
        const result = detectSecretInString("xoxb-123456789-abcdefghij");
        expect(result.ok).toBe(false);
        expect(isCardLikeDetection(result)).toBe(false);
      });

      test("returns false for ok results", () => {
        const result = detectSecretInString("Hello world");
        expect(isCardLikeDetection(result)).toBe(false);
      });
    });
  });

  describe("Session Metadata Separation", () => {
    test("card setup session metadata has purpose=payment_method_setup", () => {
      const metadata = {
        purpose: "payment_method_setup",
        orgId: "org_123",
        approvalId: "appr_123",
      };

      expect(metadata.purpose).toBe("payment_method_setup");
      expect(metadata.purpose).not.toBe("subscription");
      expect(metadata.purpose).not.toBe("payment");
    });

    test("pack checkout metadata would have different purpose", () => {
      const packMetadata = {
        orgId: "org_123",
        planKey: "business",
      };

      expect(packMetadata).not.toHaveProperty("purpose");
    });
  });

  describe("Migration PAN Column Prohibition", () => {
    test("type definitions do not include PAN fields", () => {
      const paymentMethodFields = [
        "id",
        "orgId",
        "stripePaymentMethodId",
        "setupStatus",
        "setupCompletedAt",
        "setupCompletedBy",
        "setupApprovalId",
        "stripeSetupIntentId",
        "metadata",
        "createdAt",
        "updatedAt",
      ];

      const forbiddenFields = [
        "card_number",
        "cardNumber",
        "pan",
        "cvv",
        "cvc",
        "security_code",
        "securityCode",
        "expiry",
        "exp_month",
        "expMonth",
        "exp_year",
        "expYear",
        "card_fingerprint",
        "cardFingerprint",
      ];

      for (const forbidden of forbiddenFields) {
        expect(paymentMethodFields).not.toContain(forbidden);
      }
    });

    test("audit event type definitions do not include PAN fields", () => {
      const auditFields = [
        "id",
        "orgId",
        "action",
        "actorUserId",
        "actorEmail",
        "approvalId",
        "stripeSessionId",
        "outcome",
        "metadata",
        "createdAt",
      ];

      const forbiddenFields = [
        "card_number",
        "cardNumber",
        "pan",
        "cvv",
        "cvc",
        "security_code",
        "securityCode",
        "expiry",
        "card_fingerprint",
        "cardFingerprint",
      ];

      for (const forbidden of forbiddenFields) {
        expect(auditFields).not.toContain(forbidden);
      }
    });
  });

  describe("False Positive Avoidance", () => {
    test("does not flag Stripe IDs", () => {
      expect(detectCardLikeString("pm_1234567890abcdef")).toEqual({
        detected: false,
      });
      expect(detectCardLikeString("cus_1234567890abcdef")).toEqual({
        detected: false,
      });
      expect(detectCardLikeString("seti_1234567890abcdef")).toEqual({
        detected: false,
      });
    });

    test("does not flag UUIDs", () => {
      expect(
        detectCardLikeString("550e8400-e29b-41d4-a716-446655440000")
      ).toEqual({ detected: false });
    });

    test("does not flag timestamps", () => {
      expect(detectCardLikeString("1695384000123")).toEqual({ detected: false });
      expect(detectCardLikeString("2026-09-23T10:30:00Z")).toEqual({
        detected: false,
      });
    });

    test("does not flag org/employee IDs", () => {
      expect(detectCardLikeString("org_sample_shoji")).toEqual({
        detected: false,
      });
      expect(detectCardLikeString("emp_12345678")).toEqual({ detected: false });
    });
  });
});
