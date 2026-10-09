/**
 * PR-D: APPROVER_AUTHORITY_TARGETS + classifyApproverRequirement (content-based,
 * unclear → owner). Pure; no flag needed.
 */
import { describe, expect, test } from "bun:test";
import {
  APPROVER_AUTHORITY_TARGETS,
  classifyApproverRequirement,
  isApproverAuthorityTargetTool,
} from "@/lib/approver-authority/targets";

const kind = (tool: string, adminMutation?: Record<string, unknown>, extra: Record<string, unknown> = {}, context?: Parameters<typeof classifyApproverRequirement>[0]["context"]) =>
  classifyApproverRequirement({ tool, metadata: { ...(adminMutation ? { adminMutation } : {}), ...extra }, context })?.kind ?? null;

const routes = (entries: Array<[string, string[]]>) =>
  entries.map(([k, approvers]) => ({ kind: k, approverUserIds: approvers, quorum: { type: "any" }, onExpire: "fail_closed", remindEveryDays: 1 }));
const policy = (r: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, policyId: "p", policyName: "P", routes: r, updatedAt: "t", updatedBy: "u", ...extra });

describe("targets constant", () => {
  test("one constant lists every spec target (standard and sensitive)", () => {
    for (const tool of [
      "setup.slackApprover.set", "setup.lineApproval.upsert", "setup.lineApproval.setEmployeeInbox",
      "approvalWorkflow.patch", "approvalWorkflow.bindVoter", "approvalRoutes.patch", "policy.patch",
      "employees.allowedAccounts.add", "employees.allowedAccounts.remove",
      "members.update", "employees.leave", "employees.reinstate",
    ]) expect((APPROVER_AUTHORITY_TARGETS.standardTools as readonly string[]).includes(tool)).toBe(true);
    for (const tool of ["employees.spend.set", "plan.upgrade", "members.invite", "approvers.designatedAdmins.set", "cardSetup.mintLink"]) {
      expect((APPROVER_AUTHORITY_TARGETS.sensitiveTools as readonly string[]).includes(tool)).toBe(true);
    }
    expect([...APPROVER_AUTHORITY_TARGETS.strongCapabilities].sort()).toEqual(["approve_actions", "manage_billing", "manage_spend_limits"]);
    expect(APPROVER_AUTHORITY_TARGETS.moneyScopes).toContain("commerce:order");
    expect(APPROVER_AUTHORITY_TARGETS.moneyApprovalKinds).toEqual(["decision", "other"]);
  });

  test("non-targets are not classified", () => {
    for (const tool of ["mail.send", "comm.reply", "channels.list", "", "  "]) {
      expect(isApproverAuthorityTargetTool(tool)).toBe(false);
      expect(classifyApproverRequirement({ tool, metadata: {} })).toBeNull();
    }
  });
});

describe("standard tools", () => {
  test("approver / inbox / voter / account tools → owner or designated admin", () => {
    expect(kind("setup.slackApprover.set", { slackUserId: "U1" })).toBe("owner_or_designated_admin");
    expect(kind("setup.lineApproval.upsert", { allowedUserIds: ["Uabc"] })).toBe("owner_or_designated_admin");
    expect(kind("setup.lineApproval.setEmployeeInbox", { employeeId: "e" })).toBe("owner_or_designated_admin");
    expect(kind("approvalWorkflow.patch", { stages: [] })).toBe("owner_or_designated_admin");
    expect(kind("approvalWorkflow.bindVoter", { memberId: "m" })).toBe("owner_or_designated_admin");
    expect(kind("employees.allowedAccounts.add", { employeeId: "e", provider: "slack", accountId: "U1" })).toBe("owner_or_designated_admin");
  });

  test("sensitive tools → owner", () => {
    for (const tool of APPROVER_AUTHORITY_TARGETS.sensitiveTools) {
      expect(classifyApproverRequirement({ tool, metadata: {} })).toEqual({ kind: "owner", reasons: ["sensitive_target_tool"] });
    }
  });

  test("strong capability anywhere in the change → owner", () => {
    expect(kind("approvalWorkflow.bindVoter", { memberId: "m", capabilities: ["approve_actions"] })).toBe("owner");
    expect(kind("setup.slackApprover.set", { nested: { manage_billing: true } })).toBe("owner");
    expect(kind("approvalWorkflow.patch", { stages: [{ note: "manage_spend_limits" }] })).toBe("owner");
  });
});

describe("policy.patch by content", () => {
  const ctx = { currentEmployeeScopes: ["slack:post", "mail:draft"], currentEmployeeApprovalPolicy: "always_human" };
  test("scopes / purposes / approvalPolicy without money → standard", () => {
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post", "mail:send"], allowedPurposes: ["x"], approvalPolicy: "risk_based" }, {}, ctx)).toBe("owner_or_designated_admin");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", toolApprovalDefaults: { "mail.send": "auto" } }, {}, ctx)).toBe("owner_or_designated_admin");
  });
  test("adding or removing a money scope → owner", () => {
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post", "commerce:order"], approvalPolicy: "always_human" }, {}, ctx)).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human" }, {}, { currentEmployeeScopes: ["commerce:order"], currentEmployeeApprovalPolicy: "always_human" })).toBe("owner");
  });
  test("money scope kept, nothing about money changes → standard", () => {
    const money = { currentEmployeeScopes: ["commerce:order", "slack:post"], currentEmployeeApprovalPolicy: "always_human" };
    expect(kind("policy.patch", { employeeId: "e", scopes: ["commerce:order", "slack:post"], allowedPurposes: ["y"], approvalPolicy: "always_human" }, {}, money)).toBe("owner_or_designated_admin");
  });
  test("weakening human approval for money → owner", () => {
    const money = { currentEmployeeScopes: ["commerce:order"], currentEmployeeApprovalPolicy: "always_human" };
    expect(kind("policy.patch", { employeeId: "e", scopes: ["commerce:order"], approvalPolicy: "auto" }, {}, money)).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", toolApprovalDefaults: { "commerce.order": "auto" } }, {}, ctx)).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", toolApprovalDefaults: { "billing.pay": "auto" } }, {}, ctx)).toBe("owner");
  });
  test("money tool limits / unknown keys / no context with a money scope → owner", () => {
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", actionLimits: { "commerce.order": { perDay: 99 } } }, {}, ctx)).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", spend: { monthlyJpy: 1 } }, {}, ctx)).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["commerce:order"], approvalPolicy: "always_human" })).toBe("owner");
    expect(kind("policy.patch", { employeeId: "e", scopes: ["slack:post"], approvalPolicy: "always_human", actionLimits: { "slack.post": { perDay: 5 } } }, {}, ctx)).toBe("owner_or_designated_admin");
  });
});

describe("approvalRoutes.patch by content", () => {
  const meta = (before: unknown, after: unknown, extra: Record<string, unknown> = {}) => ({ __metadata: { beforeSnapshot: before, afterSnapshot: after }, ...extra });
  const base = policy(routes([["post", ["a"]], ["mail", ["a"]], ["account", ["o"]], ["decision", ["o"]], ["other", ["o"]]]));
  test("non-money kinds changed → standard", () => {
    const after = policy(routes([["post", ["a", "b"]], ["mail", ["a"]], ["account", ["o", "d"]], ["decision", ["o"]], ["other", ["o"]]]));
    expect(kind("approvalRoutes.patch", meta(base, after))).toBe("owner_or_designated_admin");
  });
  test("money kinds (decision / other) changed or removed → owner", () => {
    const changed = policy(routes([["post", ["a"]], ["mail", ["a"]], ["account", ["o"]], ["decision", ["o", "x"]], ["other", ["o"]]]));
    expect(kind("approvalRoutes.patch", meta(base, changed))).toBe("owner");
    const removed = policy(routes([["post", ["a"]], ["mail", ["a"]], ["account", ["o"]], ["decision", ["o"]]]));
    expect(kind("approvalRoutes.patch", meta(base, removed))).toBe("owner");
  });
  test("topicGate / decision thresholds changed → owner; unknown kind → owner", () => {
    expect(kind("approvalRoutes.patch", meta(base, { ...base, topicGate: { enabled: true, sensitiveTopics: [], mainBoardChannelIds: [] } }))).toBe("owner");
    const dw = (min: number) => ({ fiscalYearStartMonth: 4, fiscalYearStartDay: 1, tiers: [], tierRouting: [{ tierId: "T2", match: { minAmountJpy: min } }] });
    expect(kind("approvalRoutes.patch", meta({ ...base, decisionWorkflow: dw(500000) }, { ...base, decisionWorkflow: dw(1000000) }))).toBe("owner");
    expect(kind("approvalRoutes.patch", meta(base, policy([...routes([["post", ["a"]]]), ...routes([["mystery", ["a"]]])])))).toBe("owner");
  });
  test("full replacement that omits topicGate removes it → owner", () => {
    const withGate = { ...base, topicGate: { enabled: true, sensitiveTopics: ["給与"], mainBoardChannelIds: [] } };
    expect(kind("approvalRoutes.patch", meta(withGate, base))).toBe("owner");
  });
  test("missing snapshots / clearOverride → owner (unclear)", () => {
    expect(kind("approvalRoutes.patch", { routes: [] })).toBe("owner");
    expect(kind("approvalRoutes.patch", meta(base, base, { clearOverride: true }))).toBe("owner");
  });
  test("web artifact {before, after} is read too", () => {
    const after = policy(routes([["post", ["z"]], ["mail", ["a"]], ["account", ["o"]], ["decision", ["o"]], ["other", ["o"]]]));
    expect(classifyApproverRequirement({ tool: "approvalRoutes.patch", metadata: { artifact: JSON.stringify({ before: base, after }) } })?.kind).toBe("owner_or_designated_admin");
    expect(classifyApproverRequirement({ tool: "approvalRoutes.patch", metadata: { artifact: "{not json" } })?.kind).toBe("owner");
  });
});

describe("future tools (PR-K hook)", () => {
  test("employees.reinstate: money scope or unknown → owner", () => {
    expect(kind("employees.reinstate", { employeeId: "e" }, {}, { currentEmployeeScopes: ["slack:post"] })).toBe("owner_or_designated_admin");
    expect(kind("employees.reinstate", { employeeId: "e" }, {}, { currentEmployeeScopes: ["commerce:order"] })).toBe("owner");
    expect(kind("employees.reinstate", { employeeId: "e" })).toBe("owner");
  });
});

test("classification never throws; failure on a target → owner", () => {
  const evil = { get adminMutation() { throw new Error("boom"); } } as unknown as Record<string, unknown>;
  expect(classifyApproverRequirement({ tool: "policy.patch", metadata: evil })).toEqual({ kind: "owner", reasons: ["classification_failed"] });
  expect(classifyApproverRequirement({ tool: "mail.send", metadata: evil })).toBeNull();
});

describe("2026-10-09 gap closure: tools that change approvers / permissions but were untargeted", () => {
  test("approval inbox changes are standard targets", () => {
    for (const tool of ["setup.approvalDelivery.autoResolve", "setup.lineApproval.demoteTelegram"]) {
      expect(isApproverAuthorityTargetTool(tool)).toBe(true);
      expect(kind(tool, {})).toBe("owner_or_designated_admin");
    }
  });

  test("employees.issue grants scopes: standard; money scope / spend / weaker money approval / unknown limits → owner", () => {
    expect(isApproverAuthorityTargetTool("employees.issue")).toBe(true);
    expect(kind("employees.issue", { displayName: "A", scopes: ["slack:post"], approvalPolicy: "risky_only" })).toBe("owner_or_designated_admin");
    expect(kind("employees.issue", { displayName: "A", scopes: ["commerce:order"], approvalPolicy: "always_human" })).toBe("owner");
    expect(kind("employees.issue", { displayName: "A", scopes: ["slack:post"], spend: { monthlyLimitJpy: 1000 } })).toBe("owner");
    expect(kind("employees.issue", { displayName: "A", scopes: ["slack:post"], actionLimits: { "commerce.order": { perDay: 3 } } })).toBe("owner");
    expect(kind("employees.issue", { displayName: "A", scopes: ["slack:post"], actionLimits: { "slack.post": { perDay: 3 } } })).toBe("owner_or_designated_admin");
    expect(kind("employees.issue", { displayName: "A", scopes: "commerce:order" })).toBe("owner");
    expect(kind("employees.issue", { displayName: "A", capabilities: ["manage_billing"] })).toBe("owner");
  });

  test("still not targets: read-only, directory and AI-identity tools", () => {
    for (const tool of ["channels.remove", "parties.remove", "employeeIdentity.upsert", "approvalWorkflow.remind", "approvalWorkflow.resendVoterVerification"]) {
      expect(isApproverAuthorityTargetTool(tool)).toBe(false);
    }
  });
});

describe("2026-10-09 review item 3: five more MCP tools are targets (owner or designated admin)", () => {
  for (const tool of ["internalAudienceRule.patch", "parties.upsert", "channels.classify", "employees.postingIdentity.set", "mailPolicy.patch"]) {
    test(tool, () => {
      expect(isApproverAuthorityTargetTool(tool)).toBe(true);
      expect((APPROVER_AUTHORITY_TARGETS.standardTools as readonly string[]).includes(tool)).toBe(true);
    });
  }
});
