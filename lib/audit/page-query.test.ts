import { afterEach, describe, expect, test } from "bun:test";
import type { AuditEvent } from "@/lib/types";

const FLAG = "AUDIT_PAGE_FILTER_PAGE_ENABLED";
const FLAG_ORGS = "AUDIT_PAGE_FILTER_PAGE_ORG_IDS";

const ORG = "org_filter_a";
const OTHER = "org_filter_b";

function ev(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "id" | "orgId" | "action" | "createdAt">
): AuditEvent {
  return {
    employeeId: null,
    credentialId: null,
    purpose: null,
    summary: partial.summary ?? partial.action,
    metadata: partial.metadata ?? {},
    ...partial,
  };
}

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[FLAG_ORGS];
});

describe("AUDIT_PAGE_FILTER_PAGE flag", () => {
  test("defaults OFF; missing orgId stays OFF", async () => {
    const { isAuditPageFilterPageEnabled, isAuditPageFilterPageEnabledForOrg } = await import(
      "@/lib/feature-flags"
    );
    expect(isAuditPageFilterPageEnabled()).toBe(false);
    expect(isAuditPageFilterPageEnabledForOrg(ORG)).toBe(false);
    expect(isAuditPageFilterPageEnabledForOrg(null)).toBe(false);
    expect(isAuditPageFilterPageEnabledForOrg("")).toBe(false);
  });

  test("ON + empty org list applies to every org; missing orgId stays OFF", async () => {
    process.env[FLAG] = "true";
    const { isAuditPageFilterPageEnabledForOrg } = await import("@/lib/feature-flags");
    expect(isAuditPageFilterPageEnabledForOrg(ORG)).toBe(true);
    expect(isAuditPageFilterPageEnabledForOrg(OTHER)).toBe(true);
    expect(isAuditPageFilterPageEnabledForOrg(null)).toBe(false);
  });

  test("ON + org allowlist is fail-closed to listed orgs only", async () => {
    process.env[FLAG] = "true";
    process.env[FLAG_ORGS] = ORG;
    const { isAuditPageFilterPageEnabledForOrg } = await import("@/lib/feature-flags");
    expect(isAuditPageFilterPageEnabledForOrg(ORG)).toBe(true);
    expect(isAuditPageFilterPageEnabledForOrg(OTHER)).toBe(false);
  });
});

describe("parseAuditPageSearch", () => {
  test("empty input is not rejected and applies no filters", async () => {
    const { parseAuditPageSearch } = await import("./page-query");
    const parsed = parseAuditPageSearch({});
    expect(parsed.rejected).toBe(false);
    expect(parsed.action).toBeNull();
    expect(parsed.fromIso).toBeNull();
    expect(parsed.toIsoExclusive).toBeNull();
    expect(parsed.result).toBeNull();
    expect(parsed.cursor).toBeNull();
  });

  test("invalid action / date / result / cursor reject (fail-closed)", async () => {
    const { parseAuditPageSearch } = await import("./page-query");
    expect(parseAuditPageSearch({ action: "admin.policy;drop" }).rejected).toBe(true);
    expect(parseAuditPageSearch({ action: "../etc" }).rejected).toBe(true);
    expect(parseAuditPageSearch({ from: "yesterday" }).rejected).toBe(true);
    expect(parseAuditPageSearch({ to: "2026-13-40" }).rejected).toBe(true);
    expect(parseAuditPageSearch({ result: "ok" }).rejected).toBe(true);
    expect(parseAuditPageSearch({ cursor: "not-a-cursor" }).rejected).toBe(true);
  });

  test("from after to rejects", async () => {
    const { parseAuditPageSearch } = await import("./page-query");
    expect(parseAuditPageSearch({ from: "2026-10-17", to: "2026-10-16" }).rejected).toBe(true);
  });

  test("YYYY-MM-DD is a JST calendar day", async () => {
    const { parseAuditPageSearch } = await import("./page-query");
    const parsed = parseAuditPageSearch({ from: "2026-10-16", to: "2026-10-16" });
    expect(parsed.rejected).toBe(false);
    expect(parsed.fromIso).toBe("2026-10-15T15:00:00.000Z");
    expect(parsed.toIsoExclusive).toBe("2026-10-16T15:00:00.000Z");
  });
});

describe("applyAuditPageQuery", () => {
  const rows: AuditEvent[] = [
    ev({
      id: "aud_1",
      orgId: ORG,
      action: "admin.policy",
      createdAt: "2026-10-16T04:00:00.000Z",
      metadata: { result: "success" },
    }),
    ev({
      id: "aud_2",
      orgId: ORG,
      action: "tool.invoke",
      createdAt: "2026-10-16T03:00:00.000Z",
      metadata: { sent: true },
    }),
    ev({
      id: "aud_3",
      orgId: ORG,
      action: "admin.policy",
      createdAt: "2026-10-15T02:00:00.000Z",
      metadata: { result: "denied" },
    }),
    ev({
      id: "aud_other",
      orgId: OTHER,
      action: "admin.policy",
      createdAt: "2026-10-16T05:00:00.000Z",
      metadata: { result: "success" },
    }),
  ];

  test("missing orgId returns no rows", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch } = await import("./page-query");
    const out = applyAuditPageQuery(rows, null, parseAuditPageSearch({}));
    expect(out.events).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });

  test("never mixes another org", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch } = await import("./page-query");
    const out = applyAuditPageQuery(rows, ORG, parseAuditPageSearch({ action: "admin.policy" }));
    expect(out.events.map((e) => e.id)).toEqual(["aud_1", "aud_3"]);
    expect(out.events.every((e) => e.orgId === ORG)).toBe(true);
  });

  test("rejected search returns no rows (does not widen)", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch } = await import("./page-query");
    const out = applyAuditPageQuery(rows, ORG, parseAuditPageSearch({ action: "admin.policy;drop" }));
    expect(out.events).toEqual([]);
  });

  test("date range uses JST day bounds", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch } = await import("./page-query");
    const out = applyAuditPageQuery(
      rows,
      ORG,
      parseAuditPageSearch({ from: "2026-10-16", to: "2026-10-16" })
    );
    expect(out.events.map((e) => e.id)).toEqual(["aud_1", "aud_2"]);
  });

  test("result filter uses stored or inferred kind", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch } = await import("./page-query");
    const denied = applyAuditPageQuery(rows, ORG, parseAuditPageSearch({ result: "denied" }));
    expect(denied.events.map((e) => e.id)).toEqual(["aud_3"]);
    const success = applyAuditPageQuery(rows, ORG, parseAuditPageSearch({ result: "success" }));
    expect(success.events.map((e) => e.id)).toEqual(["aud_1", "aud_2"]);
  });

  test("created_at cursor pages past the legacy 100-row cutoff", async () => {
    const { applyAuditPageQuery, parseAuditPageSearch, AUDIT_PAGE_FILTER_SIZE } = await import(
      "./page-query"
    );
    expect(AUDIT_PAGE_FILTER_SIZE).toBe(50);
    const many: AuditEvent[] = [];
    for (let i = 0; i < 120; i++) {
      many.push(
        ev({
          id: `aud_${String(i).padStart(3, "0")}`,
          orgId: ORG,
          action: "tool.invoke",
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        })
      );
      many.push(
        ev({
          id: `aud_x_${i}`,
          orgId: OTHER,
          action: "tool.invoke",
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        })
      );
    }
    const first = applyAuditPageQuery(many, ORG, parseAuditPageSearch({}));
    expect(first.events).toHaveLength(50);
    expect(first.events.every((e) => e.orgId === ORG)).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = applyAuditPageQuery(many, ORG, parseAuditPageSearch({ cursor: first.nextCursor! }));
    expect(second.events).toHaveLength(50);
    expect(second.events[0].id).not.toBe(first.events[0].id);
    expect(first.events.some((e) => e.id === second.events[0].id)).toBe(false);
    const third = applyAuditPageQuery(many, ORG, parseAuditPageSearch({ cursor: second.nextCursor! }));
    expect(third.events).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
    const seen = new Set([...first.events, ...second.events, ...third.events].map((e) => e.id));
    expect(seen.size).toBe(120);
  });
});
