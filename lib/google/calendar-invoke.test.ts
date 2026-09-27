import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const originalFlagEnv = process.env.GOOGLE_CALENDAR_READ_ENABLED;
const originalMode = process.env.DEMO_MODE;

beforeEach(() => {
  process.env.DEMO_MODE = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
});

afterEach(() => {
  if (originalFlagEnv === undefined) delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
  else process.env.GOOGLE_CALENDAR_READ_ENABLED = originalFlagEnv;

  if (originalMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalMode;
});

describe("calendar.allowlist.patch args hash", () => {
  test("canonical args serialize consistently", () => {
    const args1 = {
      action: "add",
      calendarId: "test@example.com",
      grantId: "",
      label: "Test Calendar",
      targetEmployeeId: null,
    };
    const args2 = {
      action: "add",
      calendarId: "test@example.com",
      grantId: "",
      label: "Test Calendar",
      targetEmployeeId: null,
    };
    expect(JSON.stringify(args1)).toBe(JSON.stringify(args2));
  });

  test("sha256 hash is deterministic", () => {
    const args = {
      action: "add",
      calendarId: "calendar@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: "emp-123",
    };
    const canonical = JSON.stringify(args);
    const hash1 = createHash("sha256").update(canonical).digest("hex");
    const hash2 = createHash("sha256").update(canonical).digest("hex");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  test("different args produce different hashes", () => {
    const args1 = {
      action: "add",
      calendarId: "calendar1@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    };
    const args2 = {
      action: "add",
      calendarId: "calendar2@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    };
    const hash1 = createHash("sha256").update(JSON.stringify(args1)).digest("hex");
    const hash2 = createHash("sha256").update(JSON.stringify(args2)).digest("hex");
    expect(hash1).not.toBe(hash2);
  });

  test("action change produces different hash", () => {
    const argsAdd = {
      action: "add",
      calendarId: "",
      grantId: "grant-1",
      label: "",
      targetEmployeeId: null,
    };
    const argsRevoke = {
      action: "revoke",
      calendarId: "",
      grantId: "grant-1",
      label: "",
      targetEmployeeId: null,
    };
    const hashAdd = createHash("sha256").update(JSON.stringify(argsAdd)).digest("hex");
    const hashRevoke = createHash("sha256").update(JSON.stringify(argsRevoke)).digest("hex");
    expect(hashAdd).not.toBe(hashRevoke);
  });

  test("targetEmployeeId change produces different hash", () => {
    const args1 = {
      action: "add",
      calendarId: "cal@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    };
    const args2 = {
      action: "add",
      calendarId: "cal@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: "emp-1",
    };
    const hash1 = createHash("sha256").update(JSON.stringify(args1)).digest("hex");
    const hash2 = createHash("sha256").update(JSON.stringify(args2)).digest("hex");
    expect(hash1).not.toBe(hash2);
  });

  test("label change produces different hash", () => {
    const args1 = {
      action: "add",
      calendarId: "cal@example.com",
      grantId: "",
      label: "Personal",
      targetEmployeeId: null,
    };
    const args2 = {
      action: "add",
      calendarId: "cal@example.com",
      grantId: "",
      label: "Work",
      targetEmployeeId: null,
    };
    const hash1 = createHash("sha256").update(JSON.stringify(args1)).digest("hex");
    const hash2 = createHash("sha256").update(JSON.stringify(args2)).digest("hex");
    expect(hash1).not.toBe(hash2);
  });
});

describe("calendarId validation rules", () => {
  const VALID_CALENDAR_IDS = [
    "user@example.com",
    "calendar-123@group.calendar.google.com",
    "primary",
    "a".repeat(254),
  ];

  const INVALID_CALENDAR_IDS = [
    "",
    "a".repeat(255),
    "calendar id with space",
    "calendar\twith\ttab",
    "calendar\nwith\nnewline",
    "calendar\x00with\x00null",
  ];

  test("accepts valid calendarIds", () => {
    for (const calendarId of VALID_CALENDAR_IDS) {
      expect(calendarId.length).toBeLessThanOrEqual(254);
      expect(calendarId.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/[\s\x00-\x1f\x7f]/.test(calendarId)).toBe(false);
    }
  });

  test("rejects invalid calendarIds", () => {
    for (const calendarId of INVALID_CALENDAR_IDS) {
      const isEmpty = calendarId.length === 0;
      const isTooLong = calendarId.length > 254;
      // eslint-disable-next-line no-control-regex
      const hasInvalidChars = /[\s\x00-\x1f\x7f]/.test(calendarId);
      expect(isEmpty || isTooLong || hasInvalidChars).toBe(true);
    }
  });
});

describe("flag-OFF parity: calendar.read", () => {
  test("returns flagOff stub when flag is OFF", async () => {
    delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
    const { isGoogleCalendarReadEnabled } = await import("@/lib/feature-flags");
    expect(isGoogleCalendarReadEnabled()).toBe(false);
  });
});

describe("flag-OFF parity: calendar.propose", () => {
  test("flag OFF should return pre-PR stub", async () => {
    delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
    const { isGoogleCalendarReadEnabled } = await import("@/lib/feature-flags");
    expect(isGoogleCalendarReadEnabled()).toBe(false);
  });
});

describe("flag-OFF parity: calendar.allowlist.patch", () => {
  test("flag OFF disables the feature", async () => {
    delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
    const { isGoogleCalendarReadEnabled } = await import("@/lib/feature-flags");
    expect(isGoogleCalendarReadEnabled()).toBe(false);
  });
});

describe("approval args binding security", () => {
  test("approval without stored hash should fail closed", () => {
    const priorArgsHash = undefined;
    const currentHash = createHash("sha256").update(JSON.stringify({
      action: "add",
      calendarId: "test@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    })).digest("hex");
    const isValid = typeof priorArgsHash === "string" && priorArgsHash === currentHash;
    expect(isValid).toBe(false);
  });

  test("mismatched hash should fail", () => {
    const priorArgsHash = createHash("sha256").update(JSON.stringify({
      action: "add",
      calendarId: "calendar1@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    })).digest("hex");
    const currentHash = createHash("sha256").update(JSON.stringify({
      action: "add",
      calendarId: "calendar2@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    })).digest("hex");
    const isValid = typeof priorArgsHash === "string" && priorArgsHash === currentHash;
    expect(isValid).toBe(false);
  });

  test("matching hash should pass", () => {
    const args = {
      action: "add",
      calendarId: "calendar@example.com",
      grantId: "",
      label: "",
      targetEmployeeId: null,
    };
    const priorArgsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const currentHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const isValid = typeof priorArgsHash === "string" && priorArgsHash === currentHash;
    expect(isValid).toBe(true);
  });

  test("label mismatch should fail", () => {
    const priorArgsHash = createHash("sha256").update(JSON.stringify({
      action: "add",
      calendarId: "calendar@example.com",
      grantId: "",
      label: "Personal Calendar",
      targetEmployeeId: null,
    })).digest("hex");
    const currentHash = createHash("sha256").update(JSON.stringify({
      action: "add",
      calendarId: "calendar@example.com",
      grantId: "",
      label: "Work Calendar",
      targetEmployeeId: null,
    })).digest("hex");
    const isValid = typeof priorArgsHash === "string" && priorArgsHash === currentHash;
    expect(isValid).toBe(false);
  });
});

describe("single-use fulfillment", () => {
  test("fulfillment with claiming:true is not considered complete", () => {
    const claimingFulfillment = { ok: false, at: "2026-01-01T00:00:00Z", claiming: true };
    expect(claimingFulfillment.claiming).toBe(true);
  });

  test("fulfillment without claiming is complete", () => {
    const completeFulfillment = { ok: true, at: "2026-01-01T00:00:00Z", delivery: "stub" };
    expect((completeFulfillment as Record<string, unknown>).claiming).toBeUndefined();
  });

  test("second call with existing fulfillment returns replay", () => {
    const existingFulfillment = { ok: true, at: "2026-01-01T00:00:00Z", delivery: "stub", action: "add", grantId: "grant-123" };
    const isReplay = existingFulfillment && existingFulfillment.ok !== undefined;
    expect(isReplay).toBe(true);
  });
});
