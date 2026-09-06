import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  setSealithProvider,
  getSealithProvider,
  stubSealithProvider,
  requestSealithTransferIfNeeded,
  type SealithProvider,
  type SealithTransferRequest,
} from "./sealith-provider";
import type { SlackAttachment } from "./apply";
import type { SealithHandoffIntent } from "./resolve";

describe("sealith-provider", () => {
  beforeEach(() => {
    setSealithProvider(null);
  });

  afterEach(() => {
    setSealithProvider(null);
  });

  describe("setSealithProvider / getSealithProvider", () => {
    test("initially returns null", () => {
      expect(getSealithProvider()).toBeNull();
    });

    test("returns set provider", () => {
      setSealithProvider(stubSealithProvider);
      expect(getSealithProvider()).toBe(stubSealithProvider);
    });

    test("can be cleared", () => {
      setSealithProvider(stubSealithProvider);
      setSealithProvider(null);
      expect(getSealithProvider()).toBeNull();
    });
  });

  describe("stubSealithProvider", () => {
    test("returns initiated transfer with generated id", async () => {
      const attachments: SlackAttachment[] = [{ name: "test.pdf", mimetype: "application/pdf" }];
      const intent: SealithHandoffIntent = { mode: "suggest", required: false };

      const result = await stubSealithProvider.requestTransfer({
        orgId: "org_test",
        employeeId: "emp_test",
        jobId: "job_123",
        attachments,
        intent,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transferId).toMatch(/^sth_/);
        expect(result.status).toBe("initiated");
      }
    });

    test("returns error for empty attachments", async () => {
      const intent: SealithHandoffIntent = { mode: "required", required: true };

      const result = await stubSealithProvider.requestTransfer({
        orgId: "org_test",
        attachments: [],
        intent,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_attachment");
      }
    });

    test("getTransferStatus returns pending", async () => {
      const result = await stubSealithProvider.getTransferStatus?.("sth_test_123");
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.status).toBe("pending");
      }
    });
  });

  describe("requestSealithTransferIfNeeded", () => {
    const baseAttachments: SlackAttachment[] = [
      { name: "doc.pdf", mimetype: "application/pdf", size: 1024 },
    ];

    test("returns blocked=false when mode is off", async () => {
      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: baseAttachments,
        intent: { mode: "off", required: false },
      });

      expect(result.blocked).toBe(false);
      expect(result.transferId).toBeUndefined();
    });

    test("returns blocked=false when no attachments", async () => {
      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: [],
        intent: { mode: "required", required: true },
      });

      expect(result.blocked).toBe(false);
    });

    test("returns blocked=true when required and no provider", async () => {
      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: baseAttachments,
        intent: { mode: "required", required: true },
      });

      expect(result.blocked).toBe(true);
      expect(result.transferStatus).toBe("failed");
    });

    test("returns blocked=false when suggest and no provider", async () => {
      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: baseAttachments,
        intent: { mode: "suggest", required: false },
      });

      expect(result.blocked).toBe(false);
    });

    test("invokes provider and returns transferId on success", async () => {
      setSealithProvider(stubSealithProvider);

      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        employeeId: "emp_test",
        jobId: "job_123",
        attachments: baseAttachments,
        intent: { mode: "suggest", required: false },
      });

      expect(result.blocked).toBe(false);
      expect(result.transferId).toMatch(/^sth_/);
      expect(result.transferStatus).toBe("initiated");
    });

    test("returns blocked=true when required and provider fails", async () => {
      const failingProvider: SealithProvider = {
        async requestTransfer() {
          return { ok: false, error: "Test failure", code: "provider_unavailable" };
        },
      };
      setSealithProvider(failingProvider);

      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: baseAttachments,
        intent: { mode: "required", required: true },
      });

      expect(result.blocked).toBe(true);
      expect(result.transferStatus).toBe("failed");
    });

    test("returns blocked=false when suggest and provider fails", async () => {
      const failingProvider: SealithProvider = {
        async requestTransfer() {
          return { ok: false, error: "Test failure", code: "provider_unavailable" };
        },
      };
      setSealithProvider(failingProvider);

      const result = await requestSealithTransferIfNeeded({
        orgId: "org_test",
        attachments: baseAttachments,
        intent: { mode: "suggest", required: false },
      });

      expect(result.blocked).toBe(false);
      expect(result.transferStatus).toBe("failed");
    });
  });
});
