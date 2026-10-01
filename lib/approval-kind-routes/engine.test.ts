/**
 * P1 Approval Kind Routes — Engine Tests
 */
import { describe, expect, test, mock } from "bun:test";
import {
  evaluateKindQuorum,
  formatKindQuorumDisplay,
  calculateDeadlineStatus,
  calculateReminderStatus,
  resolveKindApproval,
  canUserVoteOnKindApproval,
  determineDecisionTier,
  canDowngradeTier,
  getPendingApprovers,
} from "./engine";
import type { ApprovalKindRoute, DecisionTierRoute } from "./types";

const mockRoute = (): ApprovalKindRoute => ({
  kind: "post",
  approverUserIds: ["approver-1", "approver-2", "approver-3"],
  quorum: { type: "any" },
  finalGoUserId: null,
  deadlineHours: null,
  onExpire: "fail_closed",
  remindEveryDays: 3,
  notifyChannelIds: [],
});

describe("evaluateKindQuorum", () => {
  describe("any quorum", () => {
    test("met with 1 approval", () => {
      const result = evaluateKindQuorum({ type: "any" }, [
        { userId: "a", vote: "approve" },
        { userId: "b", vote: null },
      ]);
      expect(result.met).toBe(true);
      expect(result.approved).toBe(1);
      expect(result.required).toBe(1);
    });

    test("not met with 0 approvals", () => {
      const result = evaluateKindQuorum({ type: "any" }, [
        { userId: "a", vote: null },
        { userId: "b", vote: null },
      ]);
      expect(result.met).toBe(false);
    });
  });

  describe("count quorum", () => {
    test("met with exact count", () => {
      const result = evaluateKindQuorum({ type: "count", n: 2 }, [
        { userId: "a", vote: "approve" },
        { userId: "b", vote: "approve" },
        { userId: "c", vote: null },
      ]);
      expect(result.met).toBe(true);
      expect(result.approved).toBe(2);
      expect(result.required).toBe(2);
    });

    test("not met with less than count", () => {
      const result = evaluateKindQuorum({ type: "count", n: 2 }, [
        { userId: "a", vote: "approve" },
        { userId: "b", vote: null },
        { userId: "c", vote: null },
      ]);
      expect(result.met).toBe(false);
    });
  });

  describe("all quorum", () => {
    test("met with all approvals", () => {
      const result = evaluateKindQuorum({ type: "all" }, [
        { userId: "a", vote: "approve" },
        { userId: "b", vote: "approve" },
      ]);
      expect(result.met).toBe(true);
      expect(result.display).toBe("全員");
    });

    test("not met with pending votes", () => {
      const result = evaluateKindQuorum({ type: "all" }, [
        { userId: "a", vote: "approve" },
        { userId: "b", vote: null },
      ]);
      expect(result.met).toBe(false);
    });
  });
});

describe("formatKindQuorumDisplay", () => {
  test("any format", () => {
    expect(formatKindQuorumDisplay({ type: "any" }, 1, 3)).toBe("1/1");
  });

  test("count format", () => {
    expect(formatKindQuorumDisplay({ type: "count", n: 2 }, 1, 3)).toBe("1/2");
  });

  test("all format", () => {
    expect(formatKindQuorumDisplay({ type: "all" }, 2, 3)).toBe("2/3 (全員)");
  });
});

describe("calculateDeadlineStatus", () => {
  test("no deadline", () => {
    const route = mockRoute();
    route.deadlineHours = null;
    const result = calculateDeadlineStatus(route, new Date());
    expect(result.hasDeadline).toBe(false);
    expect(result.deadlineAt).toBeNull();
    expect(result.isExpired).toBe(false);
  });

  test("deadline not expired", () => {
    const route = mockRoute();
    route.deadlineHours = 72;
    const createdAt = new Date();
    const result = calculateDeadlineStatus(route, createdAt);
    expect(result.hasDeadline).toBe(true);
    expect(result.isExpired).toBe(false);
    expect(result.remainingHours).toBeGreaterThan(0);
  });

  test("deadline expired", () => {
    const route = mockRoute();
    route.deadlineHours = 1;
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const result = calculateDeadlineStatus(route, createdAt);
    expect(result.hasDeadline).toBe(true);
    expect(result.isExpired).toBe(true);
    expect(result.remainingHours).toBe(0);
  });
});

describe("calculateReminderStatus", () => {
  test("needs reminder after remindEveryDays", () => {
    const route = mockRoute();
    route.remindEveryDays = 3;
    const createdAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const result = calculateReminderStatus(route, createdAt, null);
    expect(result.needsReminder).toBe(true);
    expect(result.daysSinceCreated).toBeGreaterThanOrEqual(3);
  });

  test("no reminder needed within remindEveryDays", () => {
    const route = mockRoute();
    route.remindEveryDays = 3;
    const createdAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const result = calculateReminderStatus(route, createdAt, null);
    expect(result.needsReminder).toBe(false);
  });

  test("uses lastReminderAt as reference", () => {
    const route = mockRoute();
    route.remindEveryDays = 3;
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const lastReminderAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const result = calculateReminderStatus(route, createdAt, lastReminderAt);
    expect(result.needsReminder).toBe(false);
    expect(result.daysSinceLastReminder).toBeLessThanOrEqual(1);
  });
});

describe("resolveKindApproval", () => {
  test("pending when quorum not met", () => {
    const route = mockRoute();
    route.quorum = { type: "count", n: 2 };
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "approve" }],
      new Date(),
      null,
      []
    );
    expect(result.isComplete).toBe(false);
    expect(result.isApproved).toBe(false);
    expect(result.reason).toContain("quorum not met");
  });

  test("approved when quorum met", () => {
    const route = mockRoute();
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "approve" }],
      new Date(),
      null,
      []
    );
    expect(result.isComplete).toBe(true);
    expect(result.isApproved).toBe(true);
    expect(result.reason).toContain("approved");
  });

  test("rejected on any reject", () => {
    const route = mockRoute();
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "reject" }],
      new Date(),
      null,
      []
    );
    expect(result.isComplete).toBe(true);
    expect(result.isRejected).toBe(true);
    expect(result.reason).toContain("rejected");
  });

  test("expired with fail_closed", () => {
    const route = mockRoute();
    route.deadlineHours = 1;
    route.onExpire = "fail_closed";
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const result = resolveKindApproval(route, [], createdAt, null, []);
    expect(result.isExpired).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.reason).toContain("expired");
  });

  test("excludes requester vote (self-approval forbidden)", () => {
    const route = mockRoute();
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "requester-1", vote: "approve" }],
      new Date(),
      "requester-1",
      []
    );
    expect(result.isComplete).toBe(false);
    expect(result.quorum.approved).toBe(0);
  });

  test("excludes AI votes", () => {
    const route = mockRoute();
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "ai-1", vote: "approve" }],
      new Date(),
      null,
      ["ai-1"]
    );
    expect(result.isComplete).toBe(false);
    expect(result.quorum.approved).toBe(0);
  });

  test("awaiting finalGo", () => {
    const route = mockRoute();
    route.finalGoUserId = "final-approver";
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "approve" }],
      new Date(),
      null,
      [],
      null
    );
    expect(result.isComplete).toBe(false);
    expect(result.needsFinalGo).toBe(true);
    expect(result.reason).toContain("awaiting finalGo");
  });

  test("approved with finalGo", () => {
    const route = mockRoute();
    route.finalGoUserId = "final-approver";
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "approve" }],
      new Date(),
      null,
      [],
      "approve"
    );
    expect(result.isComplete).toBe(true);
    expect(result.isApproved).toBe(true);
    expect(result.finalGoComplete).toBe(true);
  });

  test("rejected by finalGo", () => {
    const route = mockRoute();
    route.finalGoUserId = "final-approver";
    route.quorum = { type: "any" };
    const result = resolveKindApproval(
      route,
      [{ userId: "approver-1", vote: "approve" }],
      new Date(),
      null,
      [],
      "reject"
    );
    expect(result.isComplete).toBe(true);
    expect(result.isRejected).toBe(true);
    expect(result.finalGoComplete).toBe(true);
  });
});

describe("canUserVoteOnKindApproval", () => {
  test("allowed for valid approver", () => {
    const route = mockRoute();
    const result = canUserVoteOnKindApproval(route, "approver-1", null, []);
    expect(result.allowed).toBe(true);
  });

  test("forbidden for self-approval", () => {
    const route = mockRoute();
    const result = canUserVoteOnKindApproval(route, "requester", "requester", []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("self_approval_forbidden");
  });

  test("forbidden for AI voter", () => {
    const route = mockRoute();
    route.approverUserIds = ["ai-1"];
    const result = canUserVoteOnKindApproval(route, "ai-1", null, ["ai-1"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ai_voter_forbidden");
  });

  test("forbidden for non-approver", () => {
    const route = mockRoute();
    const result = canUserVoteOnKindApproval(route, "random-user", null, []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("not_in_approvers");
  });
});

describe("determineDecisionTier", () => {
  const mockTiers: DecisionTierRoute[] = [
    {
      tier: "T1",
      nameJa: "代表理事の専決",
      approverUserIds: ["owner"],
      quorum: { type: "any" },
      onExpire: "keep_open",
      remindEveryDays: 3,
    },
    {
      tier: "T2",
      nameJa: "理事過半数",
      approverUserIds: ["owner", "admin-1", "admin-2"],
      quorum: { type: "count", n: 2 },
      deadlineHours: 72,
      onExpire: "fail_closed",
      remindEveryDays: 3,
    },
    {
      tier: "T3",
      nameJa: "社員総会",
      approverUserIds: ["owner", "member-1", "member-2"],
      quorum: { type: "all" },
      onExpire: "keep_open",
      remindEveryDays: 3,
    },
  ];

  test("defaults to T1 for small amounts", () => {
    const result = determineDecisionTier(mockTiers, 100000, 500000, null);
    expect(result?.tier).toBe("T1");
    expect(result?.autoEscalated).toBe(false);
  });

  test("auto-escalates to T2 for large amounts", () => {
    const result = determineDecisionTier(mockTiers, 500000, 500000, null);
    expect(result?.tier).toBe("T2");
    expect(result?.autoEscalated).toBe(true);
    expect(result?.escalationReason).toContain("amount");
  });

  test("auto-escalates to T3 for 定款変更", () => {
    const result = determineDecisionTier(mockTiers, 0, 500000, "定款変更");
    expect(result?.tier).toBe("T3");
    expect(result?.autoEscalated).toBe(true);
    expect(result?.escalationReason).toContain("定款変更");
  });

  test("auto-escalates to T3 for 役員", () => {
    const result = determineDecisionTier(mockTiers, 0, 500000, "役員");
    expect(result?.tier).toBe("T3");
    expect(result?.autoEscalated).toBe(true);
  });

  test("auto-escalates to T3 for 決算", () => {
    const result = determineDecisionTier(mockTiers, 0, 500000, "決算");
    expect(result?.tier).toBe("T3");
    expect(result?.autoEscalated).toBe(true);
  });
});

describe("canDowngradeTier", () => {
  test("owner can downgrade", () => {
    const result = canDowngradeTier("T2", "T1", "owner", "owner");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("owner_downgrade_allowed");
  });

  test("non-owner cannot downgrade", () => {
    const result = canDowngradeTier("T2", "T1", "other-user", "owner");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("only_owner_can_downgrade");
  });

  test("upgrade is always allowed", () => {
    const result = canDowngradeTier("T1", "T2", "anyone", "owner");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("not_a_downgrade");
  });
});

describe("getPendingApprovers", () => {
  test("returns approvers who haven't voted", () => {
    const route = mockRoute();
    const votes = [{ userId: "approver-1", vote: "approve" as const }];
    const result = getPendingApprovers(route, votes, null, []);
    expect(result).toContain("approver-2");
    expect(result).toContain("approver-3");
    expect(result).not.toContain("approver-1");
  });

  test("excludes requester", () => {
    const route = mockRoute();
    route.approverUserIds = ["requester", "approver-1"];
    const result = getPendingApprovers(route, [], "requester", []);
    expect(result).not.toContain("requester");
    expect(result).toContain("approver-1");
  });

  test("excludes AI users", () => {
    const route = mockRoute();
    route.approverUserIds = ["ai-1", "approver-1"];
    const result = getPendingApprovers(route, [], null, ["ai-1"]);
    expect(result).not.toContain("ai-1");
    expect(result).toContain("approver-1");
  });
});
