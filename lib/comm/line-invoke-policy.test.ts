/**
 * Kimura 10/14: tenant reply_policy alone must NOT waive approval for
 * external LINE. Only an explicit per-employee or per-role "no approval"
 * setting can. who/what public still sends without a card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  lineExternalNoApproval,
  lineExternalSendAllowed,
  lineForceExternalApproval,
} from "@/lib/comm/line-invoke";

const FLAGS = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("lineExternalNoApproval", () => {
  test("org / default reply_policy no_approval does not waive", () => {
    expect(lineExternalNoApproval({
      policySource: "org",
      ruleExternalApproval: "no_approval",
      roleExternalApproval: null,
      toolHint: null,
    })).toBe(false);
    expect(lineExternalNoApproval({
      policySource: "default",
      ruleExternalApproval: "no_approval",
      roleExternalApproval: null,
      toolHint: "risk_based",
    })).toBe(false);
  });

  test("employee reply_policy no_approval waives", () => {
    expect(lineExternalNoApproval({
      policySource: "employee",
      ruleExternalApproval: "no_approval",
      roleExternalApproval: null,
      toolHint: null,
    })).toBe(true);
  });

  test("per-role no_approval waives even when the tenant policy is the source", () => {
    expect(lineExternalNoApproval({
      policySource: "org",
      ruleExternalApproval: "needs_approval",
      roleExternalApproval: "no_approval",
      toolHint: null,
    })).toBe(true);
  });

  test("toolApprovalDefaults auto (explicit no approval) waives", () => {
    expect(lineExternalNoApproval({
      policySource: "org",
      ruleExternalApproval: "needs_approval",
      roleExternalApproval: null,
      toolHint: "auto",
    })).toBe(true);
  });
});

describe("lineExternalSendAllowed", () => {
  test("who/what public still allows without a card", () => {
    expect(lineExternalSendAllowed({
      priorApprovalOk: false,
      audience: "external",
      informationClass: "public",
      egressDecision: "allow",
      employeeNoApproval: false,
    })).toBe(true);
  });

  test("non-public external needs the employee/role no-approval setting", () => {
    expect(lineExternalSendAllowed({
      priorApprovalOk: false,
      audience: "external",
      informationClass: "internal",
      egressDecision: "allow",
      employeeNoApproval: false,
    })).toBe(false);
    expect(lineExternalSendAllowed({
      priorApprovalOk: false,
      audience: "external",
      informationClass: "internal",
      egressDecision: "allow",
      employeeNoApproval: true,
    })).toBe(true);
  });
});

describe("lineForceExternalApproval", () => {
  test("unclassified external deny still becomes needs_approval when no explicit waiver", () => {
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "true";
    expect(lineForceExternalApproval({
      surface: "line",
      audience: "external",
      egressDecision: "deny",
      unclassified: true,
      employeeNoApproval: false,
    })).toBe(true);
  });

  test("explicit no-approval does not force a card (waive)", () => {
    process.env.COMM_ACCOUNTS_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "true";
    expect(lineForceExternalApproval({
      surface: "line",
      audience: "external",
      egressDecision: "deny",
      unclassified: true,
      employeeNoApproval: true,
    })).toBe(false);
  });
});
