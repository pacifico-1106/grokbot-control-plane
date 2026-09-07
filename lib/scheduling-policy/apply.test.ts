import { describe, expect, test } from "bun:test";
import {
  applySchedulingPolicySync,
  isVideoToolAllowed,
  getDefaultVideoTool,
  getOnlineCalendarTarget,
  type FreebusySlot,
} from "./apply";
import { normalizeSchedulingPolicy } from "./validate";
import type { OrgSchedulingPolicy, SchedulingRule } from "@/lib/types";

function makePolicy(rules: Partial<SchedulingRule>[]): OrgSchedulingPolicy {
  return normalizeSchedulingPolicy({
    policyId: "sp_test",
    policyName: "Test Policy",
    rules: rules.map((r, i) => ({
      id: `spr_${i}`,
      confirmAutomation: "always_human",
      ...r,
    })),
  });
}

function makeSlot(id: string, overrides: Partial<FreebusySlot> = {}): FreebusySlot {
  const now = new Date();
  return {
    id,
    start: new Date(now.getTime() + 3600000).toISOString(),
    end: new Date(now.getTime() + 7200000).toISOString(),
    ...overrides,
  };
}

describe("applySchedulingPolicySync", () => {
  test("empty rules returns fail-closed", () => {
    const policy = makePolicy([]);
    policy.rules = [];
    const slots = [makeSlot("s1")];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.failClosed).toBe(true);
    expect(result.failClosedReason).toBe("no_rules_defined");
    expect(result.finalCandidates).toHaveLength(0);
  });

  test("passes all slots with default rule", () => {
    const policy = makePolicy([{ confirmAutomation: "always_human" }]);
    const slots = [makeSlot("s1"), makeSlot("s2"), makeSlot("s3")];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(3);
    expect(result.droppedCount).toBe(0);
    expect(result.keptCount).toBe(3);
    expect(result.failClosed).toBe(false);
  });

  test("drops slots in hardBlackout", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        hardBlackout: [{ dayOfWeek: [1], reason: "blackout" }],
      },
    ]);
    const slots = [makeSlot("s1", {
      start: "2026-09-07T11:00:00Z",
      end: "2026-09-07T12:00:00Z",
    })];
    const result = applySchedulingPolicySync(policy, slots, now);
    expect(result.finalCandidates).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  test("keeps slots outside hardBlackout", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        hardBlackout: [{ dayOfWeek: [0, 6], reason: "weekend" }],
      },
    ]);
    const slots = [makeSlot("s1", {
      start: "2026-09-07T11:00:00Z",
      end: "2026-09-07T12:00:00Z",
    })];
    const result = applySchedulingPolicySync(policy, slots, now);
    expect(result.finalCandidates).toHaveLength(1);
    expect(result.keptCount).toBe(1);
  });

  test("scores softPrefer slots higher", () => {
    const now = new Date("2026-09-07T10:00:00Z");
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        softPrefer: [
          { startTime: "10:00", endTime: "12:00", reason: "preferred" },
        ],
      },
    ]);

    const preferredSlot = makeSlot("s1", {
      start: "2026-09-07T10:30:00Z",
      end: "2026-09-07T11:30:00Z",
    });
    const regularSlot = makeSlot("s2", {
      start: "2026-09-07T14:00:00Z",
      end: "2026-09-07T15:00:00Z",
    });
    const slots = [regularSlot, preferredSlot];
    const result = applySchedulingPolicySync(policy, slots, now);

    expect(result.finalCandidates).toHaveLength(2);
    const preferred = result.allCandidates.find((c) => c.slot.id === "s1");
    const regular = result.allCandidates.find((c) => c.slot.id === "s2");
    expect(preferred!.score).toBeGreaterThan(regular!.score);
  });

  test("drops slots exceeding costCapJpy", () => {
    const policy = makePolicy([
      { confirmAutomation: "always_human", costCapJpy: 10000 },
    ]);
    const slots = [
      makeSlot("s1", { estimatedCostJpy: 5000 }),
      makeSlot("s2", { estimatedCostJpy: 15000 }),
    ];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(1);
    expect(result.finalCandidates[0].id).toBe("s1");
    expect(result.droppedCount).toBe(1);
  });

  test("location affinity scoring - office_first", () => {
    const policy = makePolicy([
      { confirmAutomation: "always_human", locationAffinity: "office_first" },
    ]);
    const slots = [
      makeSlot("s1", { locationHint: "オフィス", isOnline: false }),
      makeSlot("s2", { locationHint: "online", isOnline: true }),
    ];
    const result = applySchedulingPolicySync(policy, slots);

    expect(result.finalCandidates).toHaveLength(2);
    const office = result.allCandidates.find((c) => c.slot.id === "s1");
    const online = result.allCandidates.find((c) => c.slot.id === "s2");
    expect(office!.score).toBeGreaterThan(online!.score);
  });

  test("location affinity scoring - remote_first", () => {
    const policy = makePolicy([
      { confirmAutomation: "always_human", locationAffinity: "remote_first" },
    ]);
    const slots = [
      makeSlot("s1", { locationHint: "office", isOnline: false }),
      makeSlot("s2", { locationHint: "online", isOnline: true }),
    ];
    const result = applySchedulingPolicySync(policy, slots);

    expect(result.finalCandidates).toHaveLength(2);
    const office = result.allCandidates.find((c) => c.slot.id === "s1");
    const online = result.allCandidates.find((c) => c.slot.id === "s2");
    expect(online!.score).toBeGreaterThan(office!.score);
  });

  test("effectiveConfirmAutomation takes strictest level", () => {
    const policy = makePolicy([
      { confirmAutomation: "full_auto" },
      { confirmAutomation: "always_human" },
      { confirmAutomation: "risk_based" },
    ]);
    const slots = [makeSlot("s1")];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.effectiveConfirmAutomation).toBe("always_human");
  });

  test("online video tool allowlist - drops non-allowed tool", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          videoToolAllowlist: [{ tool: "zoom" }, { tool: "meet" }],
        },
      },
    ]);
    const slots = [
      makeSlot("s1", { isOnline: true, metadata: { videoTool: "zoom" } }),
      makeSlot("s2", { isOnline: true, metadata: { videoTool: "teams" } }),
    ];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(1);
    expect(result.finalCandidates[0].id).toBe("s1");
  });

  test("online calendar target - drops mismatched calendar", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          calendarTarget: "work@example.com",
          videoToolAllowlist: [],
        },
      },
    ]);
    const slots = [
      makeSlot("s1", { isOnline: true, metadata: { calendar: "work@example.com" } }),
      makeSlot("s2", { isOnline: true, metadata: { calendar: "personal@example.com" } }),
    ];
    const result = applySchedulingPolicySync(policy, slots);
    expect(result.finalCandidates).toHaveLength(1);
    expect(result.finalCandidates[0].id).toBe("s1");
  });

  test("audit labels track applied and dropped rules", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        costCapJpy: 10000,
      },
    ]);
    const slots = [
      makeSlot("s1", { estimatedCostJpy: 5000 }),
      makeSlot("s2", { estimatedCostJpy: 15000 }),
    ];
    const result = applySchedulingPolicySync(policy, slots);

    const keptLabel = result.auditLabels.find((l) => l.slotId === "s1");
    const droppedLabel = result.auditLabels.find((l) => l.slotId === "s2");

    expect(keptLabel?.kept).toBe(true);
    expect(keptLabel?.appliedRules).toContain("spr_0");
    expect(droppedLabel?.kept).toBe(false);
    expect(droppedLabel?.droppedByRules).toContain("spr_0");
  });
});

describe("isVideoToolAllowed", () => {
  test("allows any tool when no allowlist", () => {
    const policy = makePolicy([{ confirmAutomation: "always_human" }]);
    const result = isVideoToolAllowed(policy, "anyTool");
    expect(result.allowed).toBe(true);
  });

  test("allows tool in allowlist", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          videoToolAllowlist: [{ tool: "zoom" }, { tool: "meet" }],
        },
      },
    ]);
    expect(isVideoToolAllowed(policy, "zoom").allowed).toBe(true);
    expect(isVideoToolAllowed(policy, "ZOOM").allowed).toBe(true);
    expect(isVideoToolAllowed(policy, "meet").allowed).toBe(true);
  });

  test("rejects tool not in allowlist", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          videoToolAllowlist: [{ tool: "zoom" }],
        },
      },
    ]);
    const result = isVideoToolAllowed(policy, "teams");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("teams");
    expect(result.reason).toContain("allowlist");
  });
});

describe("getDefaultVideoTool", () => {
  test("returns null when no online pack", () => {
    const policy = makePolicy([{ confirmAutomation: "always_human" }]);
    expect(getDefaultVideoTool(policy)).toBeNull();
  });

  test("returns default from allowlist", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          videoToolAllowlist: [
            { tool: "zoom", isDefault: true },
            { tool: "meet" },
          ],
        },
      },
    ]);
    expect(getDefaultVideoTool(policy)).toBe("zoom");
  });

  test("returns explicit defaultVideoTool", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          defaultVideoTool: "teams",
          videoToolAllowlist: [],
        },
      },
    ]);
    expect(getDefaultVideoTool(policy)).toBe("teams");
  });
});

describe("getOnlineCalendarTarget", () => {
  test("returns null when no online pack", () => {
    const policy = makePolicy([{ confirmAutomation: "always_human" }]);
    expect(getOnlineCalendarTarget(policy)).toBeNull();
  });

  test("returns calendar target from online pack", () => {
    const policy = makePolicy([
      {
        confirmAutomation: "always_human",
        onlinePack: {
          enabled: true,
          calendarTarget: "work@example.com",
          videoToolAllowlist: [],
        },
      },
    ]);
    expect(getOnlineCalendarTarget(policy)).toBe("work@example.com");
  });
});
