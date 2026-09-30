/**
 * P1 Approval Kind Routes — FLAGS-OFF REGRESSION SUITE
 *
 * CRITICAL: With every flag OFF, behavior must be byte-for-byte the same as today.
 *
 * Flags tested:
 * - P1_APPROVAL_KIND_ROUTES_ENABLED (default OFF)
 * - P1_DECISION_WORKFLOW_ENABLED (default OFF)
 * - P1_TOPIC_GATED_POSTING_ENABLED (default OFF)
 *
 * Verifies:
 * - Existing routes[] (class=admin|business) migration behavior
 * - Owner-only default behavior
 * - No changes to approval routing when flags OFF
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => null,
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
}));

const envBackup = {
  kindRoutes: process.env.P1_APPROVAL_KIND_ROUTES_ENABLED,
  decisionWorkflow: process.env.P1_DECISION_WORKFLOW_ENABLED,
  topicGated: process.env.P1_TOPIC_GATED_POSTING_ENABLED,
};

beforeEach(() => {
  delete process.env.P1_APPROVAL_KIND_ROUTES_ENABLED;
  delete process.env.P1_DECISION_WORKFLOW_ENABLED;
  delete process.env.P1_TOPIC_GATED_POSTING_ENABLED;
});

afterEach(() => {
  process.env.P1_APPROVAL_KIND_ROUTES_ENABLED = envBackup.kindRoutes;
  process.env.P1_DECISION_WORKFLOW_ENABLED = envBackup.decisionWorkflow;
  process.env.P1_TOPIC_GATED_POSTING_ENABLED = envBackup.topicGated;
});

const {
  isApprovalKindRoutesEnabled,
  isDecisionWorkflowEnabled,
  isTopicGatedPostingEnabled,
} = await import("@/lib/feature-flags");

const {
  getEffectiveApprovalKindRoute,
  resetDemoApprovalKindRoutesData,
} = await import("@/lib/approval-kind-routes");

describe("FLAGS-OFF REGRESSION: P1 Feature flags default to OFF", () => {
  test("P1_APPROVAL_KIND_ROUTES_ENABLED is OFF by default", () => {
    expect(isApprovalKindRoutesEnabled()).toBe(false);
  });

  test("P1_DECISION_WORKFLOW_ENABLED is OFF by default", () => {
    expect(isDecisionWorkflowEnabled()).toBe(false);
  });

  test("P1_TOPIC_GATED_POSTING_ENABLED is OFF by default", () => {
    expect(isTopicGatedPostingEnabled()).toBe(false);
  });
});

describe("FLAGS-OFF REGRESSION: Approval kind routes returns default when flag OFF", () => {
  beforeEach(() => {
    resetDemoApprovalKindRoutesData();
  });

  test("getEffectiveApprovalKindRoute returns default source when flag OFF", async () => {
    const result = await getEffectiveApprovalKindRoute("test-org", "post", null, "owner-1");
    expect(result.source).toBe("default");
    expect(result.route.approverUserIds).toEqual(["owner-1"]);
    expect(result.route.quorum).toEqual({ type: "any" });
    expect(result.orgRoute).toBeNull();
    expect(result.employeeOverride).toBeNull();
  });

  test("getEffectiveApprovalKindRoute returns default for all kinds when flag OFF", async () => {
    const kinds = ["post", "mail", "account", "decision", "other"] as const;
    for (const kind of kinds) {
      const result = await getEffectiveApprovalKindRoute("test-org", kind, null, "owner-1");
      expect(result.source).toBe("default");
      expect(result.route.kind).toBe(kind);
    }
  });

  test("employee override is ignored when flag OFF", async () => {
    const result = await getEffectiveApprovalKindRoute("test-org", "post", "employee-1", "owner-1");
    expect(result.source).toBe("default");
    expect(result.employeeOverride).toBeNull();
  });
});

describe("FLAGS-OFF REGRESSION: Existing routes[] class migration preserved", () => {
  test("admin class maps to account kind", async () => {
    const { migrateClassRoutesToKindRoutes } = await import("@/lib/approval-kind-routes");

    const existingPolicy = {
      version: 1 as const,
      policyId: "existing",
      policyName: "既存ポリシー",
      stages: [
        {
          id: "s1",
          nameJa: "承認",
          voterUserIds: ["voter-1"],
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        },
      ],
      routes: [
        {
          class: "admin" as const,
          stages: [
            {
              id: "admin-s1",
              nameJa: "管理者承認",
              voterUserIds: ["admin-voter-1"],
              quorum: { type: "any" as const },
              onReject: "fail_closed" as const,
            },
          ],
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const migrated = migrateClassRoutesToKindRoutes(existingPolicy, "owner-1");
    expect(migrated).not.toBeNull();

    const accountRoute = migrated!.routes.find((r) => r.kind === "account");
    expect(accountRoute).toBeDefined();
    expect(accountRoute!.approverUserIds).toEqual(["admin-voter-1"]);
  });

  test("business class maps to post, mail, other kinds", async () => {
    const { migrateClassRoutesToKindRoutes } = await import("@/lib/approval-kind-routes");

    const existingPolicy = {
      version: 1 as const,
      policyId: "existing",
      policyName: "既存ポリシー",
      stages: [
        {
          id: "s1",
          nameJa: "承認",
          voterUserIds: ["voter-1"],
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        },
      ],
      routes: [
        {
          class: "business" as const,
          stages: [
            {
              id: "biz-s1",
              nameJa: "業務承認",
              voterUserIds: ["biz-voter-1"],
              quorum: { type: "count" as const, n: 2 },
              onReject: "fail_closed" as const,
            },
          ],
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const migrated = migrateClassRoutesToKindRoutes(existingPolicy, "owner-1");
    expect(migrated).not.toBeNull();

    const postRoute = migrated!.routes.find((r) => r.kind === "post");
    expect(postRoute).toBeDefined();
    expect(postRoute!.approverUserIds).toEqual(["biz-voter-1"]);

    const mailRoute = migrated!.routes.find((r) => r.kind === "mail");
    expect(mailRoute).toBeDefined();
    expect(mailRoute!.approverUserIds).toEqual(["biz-voter-1"]);

    const otherRoute = migrated!.routes.find((r) => r.kind === "other");
    expect(otherRoute).toBeDefined();
    expect(otherRoute!.approverUserIds).toEqual(["biz-voter-1"]);
  });

  test("uncovered kinds get owner 1名 default", async () => {
    const { migrateClassRoutesToKindRoutes } = await import("@/lib/approval-kind-routes");

    const existingPolicy = {
      version: 1 as const,
      policyId: "existing",
      policyName: "既存ポリシー",
      stages: [
        {
          id: "s1",
          nameJa: "承認",
          voterUserIds: ["voter-1"],
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        },
      ],
      routes: [
        {
          class: "admin" as const,
          stages: [
            {
              id: "admin-s1",
              nameJa: "管理者承認",
              voterUserIds: ["admin-voter-1"],
              quorum: { type: "any" as const },
              onReject: "fail_closed" as const,
            },
          ],
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const migrated = migrateClassRoutesToKindRoutes(existingPolicy, "owner-1");
    expect(migrated).not.toBeNull();

    const postRoute = migrated!.routes.find((r) => r.kind === "post");
    expect(postRoute).toBeDefined();
    expect(postRoute!.approverUserIds).toEqual(["owner-1"]);
    expect(postRoute!.quorum).toEqual({ type: "any" });
  });

  test("returns null when no existing routes", async () => {
    const { migrateClassRoutesToKindRoutes } = await import("@/lib/approval-kind-routes");

    const existingPolicy = {
      version: 1 as const,
      policyId: "existing",
      policyName: "既存ポリシー",
      stages: [
        {
          id: "s1",
          nameJa: "承認",
          voterUserIds: ["voter-1"],
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const migrated = migrateClassRoutesToKindRoutes(existingPolicy, "owner-1");
    expect(migrated).toBeNull();
  });
});

describe("FLAGS-OFF REGRESSION: Tool kind mapping behavior preserved", () => {
  test("tool kind mapping is consistent regardless of flag state", async () => {
    const { getToolApprovalKind } = await import("@/lib/approval-kind-routes");

    expect(getToolApprovalKind("slack.post")).toBe("post");
    expect(getToolApprovalKind("mail.send")).toBe("mail");
    expect(getToolApprovalKind("employees.issue")).toBe("account");
    expect(getToolApprovalKind("decision.request")).toBe("decision");
    expect(getToolApprovalKind("unknown.tool")).toBe("other");
  });
});
