/**
 * P1 Decision Workflow — Voting Card Tests
 */

import { describe, expect, test, mock } from "bun:test";
import {
  buildDecisionVotingCard,
  formatDecisionCardForSlack,
  formatDecisionCardForTelegram,
} from "./voting-card";
import type { ApprovalRequest } from "@/lib/types";

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => null,
}));

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
}));

const mockApproval: ApprovalRequest = {
  id: "approval-1",
  orgId: "org-1",
  employeeId: "emp-1",
  credentialId: "cred-1",
  title: "サーバー購入稟議",
  summary: "開発環境用サーバーの購入",
  purpose: "インフラ更新",
  jobId: "job-1",
  tool: "decision.request",
  risk: "medium",
  status: "pending",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  revisionNote: null,
  revisionCount: 0,
  parentApprovalId: null,
  telegramRef: null,
  telegramMessageId: null,
  statusToken: "test-token",
  pollPath: "/api/approvals/approval-1/poll",
  metadata: {},
};

describe("buildDecisionVotingCard", () => {
  test("builds card with basic metadata", () => {
    const metadata = {
      tier: "T1",
      amountJpy: 100000,
      taxExcludedAmountJpy: 90909,
      category: "備品",
      fiscalYear: "FY2024",
      approverUserIds: ["user-1", "user-2"],
      votes: {},
      quorum: { type: "any" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.title).toBe("サーバー購入稟議");
    expect(card.tier).toBe("T1");
    expect(card.tierLabel).toBe("専決");
    expect(card.amountJpy).toBe(100000);
    expect(card.taxExcludedAmountJpy).toBe(90909);
    expect(card.category).toBe("備品");
    expect(card.fiscalYear).toBe("FY2024");
  });

  test("builds card with T2 tier", () => {
    const metadata = {
      tier: "T2",
      approverUserIds: ["user-1", "user-2", "user-3"],
      votes: {},
      quorum: { type: "count", n: 2 },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.tier).toBe("T2");
    expect(card.tierLabel).toBe("理事過半数");
    expect(card.actions.length).toBe(4);
    expect(card.actions.some((a) => a.type === "add_comment")).toBe(true);
  });

  test("builds card with T3 tier", () => {
    const metadata = {
      tier: "T3",
      approverUserIds: ["user-1", "user-2", "user-3", "user-4"],
      votes: {},
      quorum: { type: "all" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.tier).toBe("T3");
    expect(card.tierLabel).toBe("社員総会");
  });

  test("calculates progress from votes", () => {
    const metadata = {
      tier: "T2",
      approverUserIds: ["user-1", "user-2", "user-3"],
      votes: {
        "user-1": "approve",
        "user-2": "reject",
      },
      quorum: { type: "count", n: 2 },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.progress.approvedCount).toBe(1);
    expect(card.progress.rejectedCount).toBe(1);
    expect(card.progress.pendingCount).toBe(1);
    expect(card.progress.totalVoters).toBe(3);
    expect(card.progress.quorumMet).toBe(false);
  });

  test("detects quorum met", () => {
    const metadata = {
      tier: "T1",
      approverUserIds: ["user-1", "user-2"],
      votes: {
        "user-1": "approve",
      },
      quorum: { type: "any" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.progress.quorumMet).toBe(true);
  });

  test("includes deadline info", () => {
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const metadata = {
      tier: "T2",
      approverUserIds: ["user-1"],
      votes: {},
      quorum: { type: "any" },
      deadlineAt: deadline.toISOString(),
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.deadline).toBeDefined();
    expect(card.progress.isExpired).toBe(false);
  });

  test("detects expired deadline", () => {
    const deadline = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const metadata = {
      tier: "T2",
      approverUserIds: ["user-1"],
      votes: {},
      quorum: { type: "any" },
      deadlineAt: deadline.toISOString(),
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);

    expect(card.progress.isExpired).toBe(true);
  });
});

describe("formatDecisionCardForSlack", () => {
  test("formats card with header and actions", () => {
    const metadata = {
      tier: "T2",
      amountJpy: 500000,
      approverUserIds: ["user-1", "user-2"],
      votes: {},
      quorum: { type: "count", n: 2 },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);
    const slack = formatDecisionCardForSlack(card);

    expect(slack.text).toContain("理事過半数");
    expect(slack.text).toContain("サーバー購入稟議");
    expect(slack.blocks.length).toBeGreaterThan(0);
    expect((slack.blocks[0] as Record<string, unknown>).type).toBe("header");
  });

  test("includes amount fields when present", () => {
    const metadata = {
      tier: "T1",
      amountJpy: 100000,
      taxExcludedAmountJpy: 90909,
      approverUserIds: ["user-1"],
      votes: {},
      quorum: { type: "any" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);
    const slack = formatDecisionCardForSlack(card);

    const hasAmountSection = slack.blocks.some(
      (b: unknown) =>
        typeof b === "object" &&
        b !== null &&
        "type" in b &&
        b.type === "section" &&
        "fields" in b &&
        Array.isArray(b.fields) &&
        b.fields.some(
          (f: unknown) =>
            typeof f === "object" &&
            f !== null &&
            "text" in f &&
            typeof f.text === "string" &&
            f.text.includes("金額")
        )
    );
    expect(hasAmountSection).toBe(true);
  });
});

describe("formatDecisionCardForTelegram", () => {
  test("formats card with HTML and inline keyboard", () => {
    const metadata = {
      tier: "T1",
      amountJpy: 50000,
      approverUserIds: ["user-1"],
      votes: {},
      quorum: { type: "any" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);
    const telegram = formatDecisionCardForTelegram(card);

    expect(telegram.text).toContain("<b>【専決】サーバー購入稟議</b>");
    expect(telegram.text).toContain("Tier:");
    expect(telegram.inlineKeyboard.length).toBeGreaterThan(0);
  });

  test("includes approve and reject buttons", () => {
    const metadata = {
      tier: "T1",
      approverUserIds: ["user-1"],
      votes: {},
      quorum: { type: "any" },
    };

    const card = buildDecisionVotingCard(mockApproval, metadata);
    const telegram = formatDecisionCardForTelegram(card);

    const allButtons = telegram.inlineKeyboard.flat();
    expect(allButtons.some((b: unknown) => typeof b === "object" && b !== null && "text" in b && b.text === "承認")).toBe(true);
    expect(allButtons.some((b: unknown) => typeof b === "object" && b !== null && "text" in b && b.text === "却下")).toBe(true);
  });
});
