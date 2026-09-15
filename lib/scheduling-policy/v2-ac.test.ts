/**
 * P0-A1 scheduling.policy v2 acceptance criteria tests.
 * A1-1 through A1-6 per Yasaka GO 2026-09-15.
 */
import { describe, expect, test } from "bun:test";
import { applySchedulingPolicySync, resolveCalendarConfirmAutomation } from "./apply";
import { applySchedulingPolicyToProposeSync } from "./propose";
import { validateSchedulingPolicy, normalizeSchedulingPolicy } from "./validate";
import type { OrgSchedulingPolicy, SchedulingRule } from "@/lib/types";

function makePolicy(
  rules: Partial<SchedulingRule>[],
  extras: Partial<OrgSchedulingPolicy> = {}
): OrgSchedulingPolicy {
  return normalizeSchedulingPolicy({
    policyId: "sp_v2_test",
    policyName: "V2 Test Policy",
    rules: rules.map((r, i) => ({
      id: `spr_${i}`,
      confirmAutomation: "always_human",
      ...r,
    })),
    ...extras,
  });
}

function slot(
  id: string,
  start: string,
  end: string,
  overrides: Record<string, unknown> = {}
) {
  return { id, start, end, ...overrides };
}

describe("A1-1: two calendars union_busy drops slot busy on either", () => {
  test("drops candidate when busy on cal-a OR cal-b", () => {
    const policy = makePolicy([
      {
        calendarSources: {
          ids: ["cal-a", "cal-b"],
          freeBusyMerge: "union_busy",
        },
      },
    ]);

    const candidates = [
      slot("s1", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z"),
      slot("s2", "2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"),
    ];

    const busyByCalendar = {
      "cal-a": [{ start: "2026-09-15T09:30:00Z", end: "2026-09-15T10:30:00Z" }],
      "cal-b": [],
    };

    const result = applySchedulingPolicyToProposeSync(policy, candidates, undefined, busyByCalendar);

    expect(result.finalCandidates).toHaveLength(1);
    expect(result.finalCandidates[0].id).toBe("s2");
    expect(result.droppedCount).toBe(1);
    expect(result.failClosed).toBe(false);
  });

  test("drops when busy only on second calendar", () => {
    const policy = makePolicy([
      {
        calendarSources: {
          ids: ["cal-a", "cal-b"],
          freeBusyMerge: "union_busy",
        },
      },
    ]);

    const candidates = [slot("s1", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z")];
    const busyByCalendar = {
      "cal-a": [],
      "cal-b": [{ start: "2026-09-15T10:00:00Z", end: "2026-09-15T11:00:00Z" }],
    };

    const result = applySchedulingPolicyToProposeSync(policy, candidates, undefined, busyByCalendar);
    expect(result.finalCandidates).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });
});

describe("A1-2: title_tag online vs default in_person", () => {
  test("title with online tag → online; plain title → in_person default", () => {
    const policy = makePolicy([
      {
        meetingMode: {
          strategy: "title_tag",
          onlineTitleTags: ["[Online]", "オンライン"],
          defaultMode: "in_person",
          onUnspecified: "drop",
        },
      },
    ]);

    const slots = [
      slot("online", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z", {
        title: "打合せ [Online]",
      }),
      slot("inperson", "2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z", {
        title: "オフィス訪問",
      }),
    ];

    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(2);

    const onlineLabel = result.auditLabels.find((l) => l.slotId === "online");
    const inpersonLabel = result.auditLabels.find((l) => l.slotId === "inperson");

    expect(onlineLabel?.meetingMode).toBe("online");
    expect(inpersonLabel?.meetingMode).toBe("in_person");
  });
});

describe("A1-3: denyRegions drops in-person with reason on audit", () => {
  test("denyRegions drops in-person slot with region reason", () => {
    const policy = makePolicy(
      [
        {
          meetingMode: {
            strategy: "explicit_only",
            defaultMode: "in_person",
            onUnspecified: "drop",
          },
          areaPolicy: {
            denyRegions: ["remote"],
          },
        },
      ],
      {
        regionDictionary: {
          version: 1,
          defaultCountry: "JP",
          regions: [
            { code: "tokyo", labelJa: "東京" },
            { code: "remote", labelJa: "地方", aliases: ["地方"] },
          ],
        },
      }
    );

    const slots = [
      slot("allowed", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z", {
        meetingModeExplicit: "in_person",
        regionHint: "tokyo",
      }),
      slot("denied", "2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z", {
        meetingModeExplicit: "in_person",
        regionHint: "remote",
      }),
    ];

    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(1);
    expect(result.finalCandidates[0].id).toBe("allowed");

    const deniedLabel = result.auditLabels.find((l) => l.slotId === "denied");
    expect(deniedLabel?.kept).toBe(false);
    expect(deniedLabel?.reason).toContain("denyRegions remote");
    expect(deniedLabel?.region).toBe("remote");
  });
});

describe("A1-4: confirm always_human regression", () => {
  test("default policy confirm automation is always_human", () => {
    const policy = makePolicy([{ confirmAutomation: "always_human" }]);
    expect(resolveCalendarConfirmAutomation(policy)).toBe("always_human");
  });

  test("mixed rules take strictest (always_human wins)", () => {
    const policy = makePolicy([
      { confirmAutomation: "full_auto" },
      { confirmAutomation: "always_human" },
    ]);
    expect(resolveCalendarConfirmAutomation(policy)).toBe("always_human");
  });

  test("propose with default source returns always_human", () => {
    const result = applySchedulingPolicyToProposeSync(null, [
      slot("s1", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z"),
    ]);
    expect(result.effectiveConfirmAutomation).toBe("always_human");
  });
});

describe("A1-5: empty calendarSources.ids → escalate not widen", () => {
  test("empty ids fail-closed with no candidates egressed", () => {
    const policy = makePolicy([
      {
        calendarSources: {
          ids: [],
          freeBusyMerge: "union_busy",
        },
      },
    ]);

    const candidates = [
      slot("s1", "2026-09-15T10:00:00Z", "2026-09-15T11:00:00Z"),
      slot("s2", "2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"),
    ];

    const result = applySchedulingPolicyToProposeSync(policy, candidates);
    expect(result.failClosed).toBe(true);
    expect(result.failClosedReason).toBe("empty_calendar_sources");
    expect(result.finalCandidates).toHaveLength(0);
    expect(result.keptCount).toBe(0);
  });
});

describe("A1-6: full_auto without consent cannot patch (regression)", () => {
  test("rejects full_auto without highRiskConsent", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "full_auto" }],
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "high_risk_consent_required")).toBe(true);
    }
  });

  test("accepts full_auto with consent", () => {
    const result = validateSchedulingPolicy(
      {
        rules: [{ confirmAutomation: "full_auto" }],
        highRiskConsentAt: "2026-09-15T00:00:00Z",
        highRiskConsentBy: "admin@example.com",
      },
      { requireHighRiskConsent: true }
    );
    expect(result.ok).toBe(true);
  });
});

describe("A1 v2: unknown fields → validation error", () => {
  test("rejects unknown rule field", () => {
    const result = validateSchedulingPolicy({
      rules: [{ confirmAutomation: "always_human", unknownField: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "unknown_field")).toBe(true);
    }
  });

  test("rejects unknown policy field", () => {
    const result = validateSchedulingPolicy({
      rules: [{ confirmAutomation: "always_human" }],
      extraPolicyField: "bad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "unknown_field")).toBe(true);
    }
  });
});
