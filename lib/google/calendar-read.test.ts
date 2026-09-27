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

describe("calendar read with flag OFF", () => {
  test("returns empty result when flag is OFF", async () => {
    delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
    const { readCalendarFreebusy } = await import("./calendar-read");
    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar1@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.busyByCalendar).toEqual({});
    expect(result.refused).toEqual(["calendar1@example.com"]);
    expect(result.queried).toEqual([]);
    expect(result.auditMetadata.flagOff).toBe(true);
  });

  test("flag OFF parity: no Google API calls made", async () => {
    delete process.env.GOOGLE_CALENDAR_READ_ENABLED;
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCallCount++;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;

    try {
      const { readCalendarFreebusy } = await import("./calendar-read");
      await readCalendarFreebusy({
        orgId: "org-1",
        employeeId: "emp-1",
        calendarIds: ["calendar1@example.com"],
        timeMin: "2026-01-01T00:00:00Z",
        timeMax: "2026-01-02T00:00:00Z",
      });

      expect(fetchCallCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("calendar read allowlist enforcement", () => {
  test("refuses calendar IDs not in allowlist", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["not-allowed@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    expect(result.refused).toContain("not-allowed@example.com");
    expect(result.queried).not.toContain("not-allowed@example.com");
    expect(result.auditMetadata.allRefused).toBe(true);
  });

  test("mixed request: unlisted calendars in refused, listed could be queried", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar1@example.com", "calendar2@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    expect(result.refused.length).toBe(2);
    expect(result.refused).toContain("calendar1@example.com");
    expect(result.refused).toContain("calendar2@example.com");
    expect(result.queried.length).toBe(0);
    expect(result.auditMetadata.allRefused).toBe(true);
  });
});

describe("calendar read window validation", () => {
  test("rejects window larger than 31 days", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-03-01T00:00:00Z",
    });

    expect(result.ok).toBe(false);
    expect(result.errors._request?.code).toBe("window_too_large");
    expect(result.auditMetadata.windowTooLarge).toBe(true);
  });

  test("accepts 31-day window", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-02-01T00:00:00Z",
    });

    expect(result.errors._request).toBeUndefined();
  });
});

describe("secret safety", () => {
  test("audit metadata never contains tokens", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    const metadataStr = JSON.stringify(result.auditMetadata);
    expect(metadataStr).not.toContain("token");
    expect(metadataStr).not.toContain("refresh");
    expect(metadataStr).not.toContain("access");
    expect(metadataStr).not.toContain("secret");
  });

  test("result never contains tokens", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["calendar@example.com"],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("refreshToken");
    expect(resultStr).not.toContain("accessToken");
    expect(resultStr).not.toContain("credentials_ciphertext");
  });
});

describe("empty and edge cases", () => {
  test("handles empty calendar IDs array", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: [],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    expect(result.busyByCalendar).toEqual({});
    expect(result.auditMetadata.noCalendarsRequested).toBe(true);
  });

  test("trims and filters whitespace calendar IDs", async () => {
    process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
    const { readCalendarFreebusy } = await import("./calendar-read");

    const result = await readCalendarFreebusy({
      orgId: "org-1",
      employeeId: "emp-1",
      calendarIds: ["  ", "", "   "],
      timeMin: "2026-01-01T00:00:00Z",
      timeMax: "2026-01-02T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    expect(result.busyByCalendar).toEqual({});
  });
});
