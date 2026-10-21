/**
 * MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED (Investigation C follow-up).
 *
 * When audience=internal AND no rule matches AND the first rule is
 * audience=external, return needs_approval like an empty rule list instead of
 * borrowing the first (external) rule's draft/reject.
 *
 * Master flag + _ORG_IDS, default OFF. OFF must match main.
 * fail-first: these cases are written before the evaluator change.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evaluateMailPolicy } from "./apply";
import { defaultMailPolicy, normalizeMailPolicy } from "./validate";
import type {
  MailPolicyRule,
  OrgInternalAudienceRule,
  OrgMailPolicy,
} from "@/lib/types";

const FLAG = "MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED";
const ORG_IDS = "MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ORG_IDS";

const ORG_IN = "11111111-1111-1111-1111-111111111111";
const ORG_OUT = "22222222-2222-2222-2222-222222222222";

const INTERNAL: OrgInternalAudienceRule = {
  version: 1,
  emailDomains: ["ourco.example"],
  slackTeamIds: [],
  autoSlackTeamInternal: false,
  updatedAt: "2026-10-01T00:00:00Z",
  updatedBy: "test",
};

const backups: Record<string, string | undefined> = {};

function saveEnv() {
  backups[FLAG] = process.env[FLAG];
  backups[ORG_IDS] = process.env[ORG_IDS];
}

function restoreEnv() {
  for (const key of [FLAG, ORG_IDS]) {
    if (backups[key] === undefined) delete process.env[key];
    else process.env[key] = backups[key];
  }
}

function flagOff() {
  delete process.env[FLAG];
  delete process.env[ORG_IDS];
}

function flagOn(orgIds?: string) {
  process.env[FLAG] = "true";
  if (orgIds === undefined) delete process.env[ORG_IDS];
  else process.env[ORG_IDS] = orgIds;
}

function makePolicy(rules: Partial<MailPolicyRule>[]): OrgMailPolicy {
  return normalizeMailPolicy({
    policyId: "mpp_internal_nomatch",
    policyName: "Internal nomatch test",
    rules: rules.map((r, i) => ({ id: `mpr_${i}`, sendMode: "draft_only", ...r })),
  });
}

function evalDefaultInternal(orgId: string) {
  return evaluateMailPolicy({
    policy: defaultMailPolicy(),
    to: "a@ourco.example",
    internalAudienceRule: INTERNAL,
    orgId,
  });
}

function evalDefaultExternal(orgId: string) {
  return evaluateMailPolicy({
    policy: defaultMailPolicy(),
    to: "x@customer.example",
    internalAudienceRule: INTERNAL,
    orgId,
  });
}

function evalEmptyInternal(orgId: string) {
  return evaluateMailPolicy({
    policy: { ...defaultMailPolicy(), rules: [] },
    to: "a@ourco.example",
    internalAudienceRule: INTERNAL,
    orgId,
  });
}

beforeEach(() => {
  saveEnv();
  flagOff();
});

afterEach(() => {
  restoreEnv();
});

describe("MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED OFF (regression)", () => {
  test("default policy: unmatched internal keeps first external draft (main)", () => {
    const d = evalDefaultInternal(ORG_IN);
    expect(d.audience).toBe("internal");
    expect(d.demotedToDraft).toBe(true);
    expect(d.needsApproval).toBe(false);
    expect(d.rejected).toBe(false);
    expect(d.sendMode).toBe("draft_only");
    expect(d.code).toBe("mail_send_demoted_to_draft");
    expect(d.appliedRules).toContain("mpr_default_external");
    expect(d.auditLabels).toContain("rule:no_match");
  });

  test("default policy: external still draft", () => {
    const d = evalDefaultExternal(ORG_IN);
    expect(d.audience).toBe("external");
    expect(d.demotedToDraft).toBe(true);
    expect(d.needsApproval).toBe(false);
    expect(d.appliedRules).toContain("mpr_default_external");
  });
});

describe("MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED ON: internal nomatch + first rule external", () => {
  test("default policy internal → needs_approval like empty rules", () => {
    flagOn();
    const empty = evalEmptyInternal(ORG_IN);
    const d = evalDefaultInternal(ORG_IN);
    expect(d.audience).toBe("internal");
    expect(d.needsApproval).toBe(true);
    expect(d.demotedToDraft).toBe(false);
    expect(d.rejected).toBe(false);
    expect(d.autoSend).toBe(false);
    expect(d.sendMode).toBe("needs_approval");
    expect(d.code).toBeUndefined();
    expect(d.appliedRules).toEqual([]);
    expect(d.auditLabels).toContain("rule:no_match");
    expect(d.auditLabels).toContain("sendMode:needs_approval");
    expect(d.needsApproval).toBe(empty.needsApproval);
    expect(d.demotedToDraft).toBe(empty.demotedToDraft);
    expect(d.sendMode).toBe(empty.sendMode);
    expect(d.appliedRules).toEqual(empty.appliedRules);
    expect(d.code).toBe(empty.code);
  });
});

describe("MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED ON: external unchanged", () => {
  test("default policy external stays draft_only (never loosened)", () => {
    flagOn();
    const d = evalDefaultExternal(ORG_IN);
    expect(d.audience).toBe("external");
    expect(d.demotedToDraft).toBe(true);
    expect(d.needsApproval).toBe(false);
    expect(d.sendMode).toBe("draft_only");
    expect(d.code).toBe("mail_send_demoted_to_draft");
    expect(d.appliedRules).toContain("mpr_default_external");
  });

  test("unmatched external still floors to approval and keeps a stricter first-rule draft", () => {
    flagOn();
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "internal", sendMode: "auto" }]),
      to: "x@customer.example",
      internalAudienceRule: INTERNAL,
      orgId: ORG_IN,
    });
    expect(d.audience).toBe("external");
    expect(d.autoSend).toBe(false);
    expect(d.needsApproval).toBe(true);
    expect(d.demotedToDraft).toBe(false);
    expect(d.auditLabels).toContain("rule:no_match");
  });
});

describe("MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ENABLED ON: first internal rule stays strict", () => {
  test("first rule audience=internal allowlist miss stays reject", () => {
    flagOn();
    const d = evaluateMailPolicy({
      policy: makePolicy([
        {
          audience: "internal",
          sendMode: "draft_only",
          toDomainAllowlist: ["other.example"],
        },
      ]),
      to: "a@ourco.example",
      internalAudienceRule: INTERNAL,
      orgId: ORG_IN,
    });
    expect(d.audience).toBe("internal");
    expect(d.rejected).toBe(true);
    expect(d.rejectCode).toBe("mail_domain_not_allowed");
    expect(d.needsApproval).toBe(false);
    expect(d.appliedRules).toContain("mpr_0");
  });

  test("first rule audience=internal draft_only match stays draft", () => {
    flagOn();
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "internal", sendMode: "draft_only" }]),
      to: "a@ourco.example",
      internalAudienceRule: INTERNAL,
      orgId: ORG_IN,
    });
    expect(d.audience).toBe("internal");
    expect(d.demotedToDraft).toBe(true);
    expect(d.needsApproval).toBe(false);
    expect(d.sendMode).toBe("draft_only");
    expect(d.appliedRules).toContain("mpr_0");
  });
});

describe("MAIL_POLICY_INTERNAL_NOMATCH_APPROVAL_ORG_IDS: out-of-list org is not targeted", () => {
  test("ENABLED ON + list excludes org → unmatched internal keeps first-rule draft", () => {
    flagOn(ORG_IN);
    const d = evalDefaultInternal(ORG_OUT);
    expect(d.audience).toBe("internal");
    expect(d.demotedToDraft).toBe(true);
    expect(d.needsApproval).toBe(false);
    expect(d.sendMode).toBe("draft_only");
    expect(d.appliedRules).toContain("mpr_default_external");
  });

  test("ENABLED ON + list includes org → unmatched internal is needs_approval", () => {
    flagOn(ORG_IN);
    const d = evalDefaultInternal(ORG_IN);
    expect(d.needsApproval).toBe(true);
    expect(d.demotedToDraft).toBe(false);
    expect(d.appliedRules).toEqual([]);
    expect(d.sendMode).toBe("needs_approval");
  });
});
