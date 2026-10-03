/**
 * Mail policy hardening (follow-up to PR #223).
 * Concerns 1–4 in lib/mail-policy/apply.ts. Concern 5 (deny hint) lives in
 * lib/gateway/invoke-mail-policy-hardening.test.ts.
 *
 * Every concern has a "before: could send" reproduction (asserted against the
 * frozen legacy evaluator) and an "after" assertion on the hardened evaluator.
 * The grid test proves the hardened evaluator is never looser than legacy
 * (main 856264b == PR #223 for apply.ts). Dummy domains only.
 */
import { describe, expect, test } from "bun:test";
import { evaluateMailPolicy, extractMailRecipients } from "./apply";
import { evaluateMailPolicy as legacyEvaluateMailPolicy } from "./__fixtures__/legacy-apply-856264b";
import { defaultMailPolicy, normalizeMailPolicy } from "./validate";
import type {
  MailPolicyDecision,
  MailPolicyRule,
  OrgIngressHandoffPolicy,
  OrgInternalAudienceRule,
  OrgMailPolicy,
} from "@/lib/types";

const CONSENT = { highRiskConsentAt: "2026-10-01T00:00:00Z", highRiskConsentBy: "admin@dummy.example" };

const INTERNAL: OrgInternalAudienceRule = {
  version: 1,
  emailDomains: ["ourco.example"],
  slackTeamIds: [],
  autoSlackTeamInternal: false,
  updatedAt: "2026-10-01T00:00:00Z",
  updatedBy: "test",
};

function makePolicy(
  rules: Partial<MailPolicyRule>[],
  extras: Partial<OrgMailPolicy> = {}
): OrgMailPolicy {
  return normalizeMailPolicy({
    policyId: "mpp_hardening_test",
    policyName: "Hardening Test",
    rules: rules.map((r, i) => ({ id: `mpr_${i}`, sendMode: "draft_only", ...r })),
    ...extras,
  });
}

/** Strictness rank: higher = stricter. reject > draft > approval > defer-to-gate > auto. */
function rank(d: Pick<MailPolicyDecision, "rejected" | "demotedToDraft" | "needsApproval" | "autoSend">): number {
  if (d.rejected) return 4;
  if (d.demotedToDraft) return 3;
  if (d.needsApproval) return 2;
  if (!d.autoSend) return 1;
  return 0;
}

function canSendWithoutHuman(d: MailPolicyDecision): boolean {
  return !d.rejected && !d.demotedToDraft && d.autoSend && !d.needsApproval;
}

describe("concern 1: no matching rule must not borrow the first rule's auto", () => {
  const policy = makePolicy([{ audience: "internal", sendMode: "auto" }], CONSENT);
  const input = { policy, to: "x@customer.example", internalAudienceRule: INTERNAL };

  test("before: external recipient auto-sent under an internal-only auto rule", () => {
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
  });

  test("after: no match → approval required (never auto)", () => {
    const d = evaluateMailPolicy(input);
    expect(d.autoSend).toBe(false);
    expect(d.needsApproval).toBe(true);
    expect(d.rejected).toBe(false);
    expect(d.auditLabels).toContain("rule:no_match");
  });

  test("after: no match keeps a stricter legacy outcome (default policy internal stays draft)", () => {
    const d = evaluateMailPolicy({ policy: defaultMailPolicy(), to: "a@ourco.example", internalAudienceRule: INTERNAL });
    expect(d.demotedToDraft).toBe(true);
  });

  test("after: allowlist-only policy still rejects a domain outside the allowlist", () => {
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"] }], CONSENT),
      to: "x@customer.example",
    });
    expect(d.rejected).toBe(true);
    expect(d.rejectCode).toBe("mail_domain_not_allowed");
  });

  test("after: empty rule list → approval required for internal, draft for external", () => {
    const empty = { ...defaultMailPolicy(), rules: [] };
    expect(evaluateMailPolicy({ policy: empty, to: "a@ourco.example", internalAudienceRule: INTERNAL }).needsApproval).toBe(true);
    expect(evaluateMailPolicy({ policy: empty, to: "x@customer.example", internalAudienceRule: INTERNAL }).demotedToDraft).toBe(true);
  });
});

describe("concern 2: every recipient in to / cc / bcc is judged", () => {
  test("before/after: denylisted CC", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "a@ok.example",
      cc: ["z@blocked.example"],
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    const d = evaluateMailPolicy(input);
    expect(d.rejected).toBe(true);
    expect(d.rejectCode).toBe("mail_domain_denied");
  });

  test("before/after: denylisted BCC", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "a@ok.example",
      bcc: ["z@blocked.example"],
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    expect(evaluateMailPolicy(input).rejectCode).toBe("mail_domain_denied");
  });

  test("before/after: CC outside the allowlist", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainAllowlist: ["partner.example"] }], CONSENT),
      to: "y@partner.example",
      cc: ["x@customer.example"],
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    expect(evaluateMailPolicy(input).rejectCode).toBe("mail_domain_not_allowed");
  });

  test("before/after: internal to + external BCC makes the whole mail external", () => {
    const input = {
      policy: makePolicy(
        [
          { audience: "internal", sendMode: "auto" },
          { audience: "external", sendMode: "draft_only" },
        ],
        CONSENT
      ),
      to: "me@ourco.example",
      bcc: ["x@customer.example"],
      internalAudienceRule: INTERNAL,
    };
    const legacy = legacyEvaluateMailPolicy(input);
    expect(legacy.audience).toBe("internal");
    expect(canSendWithoutHuman(legacy)).toBe(true);
    const d = evaluateMailPolicy(input);
    expect(d.audience).toBe("external");
    expect(d.demotedToDraft).toBe(true);
  });

  test("after: internal recipients of an external mail are also judged by external rules", () => {
    const d = evaluateMailPolicy({
      policy: makePolicy(
        [
          { audience: "internal", sendMode: "needs_approval", priority: 0 },
          { audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"], priority: 1 },
          { audience: "external", sendMode: "draft_only", priority: 2 },
        ],
        CONSENT
      ),
      to: "y@partner.example",
      cc: ["a@ourco.example"],
      internalAudienceRule: INTERNAL,
    });
    expect(d.audience).toBe("external");
    expect(d.demotedToDraft).toBe(true);
  });

  test("before/after: multi-address to string — every address is parsed (comma)", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainAllowlist: ["partner.example"] }], CONSENT),
      to: "x@evil.example, y@partner.example",
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    expect(evaluateMailPolicy(input).rejectCode).toBe("mail_domain_not_allowed");
  });

  test("before/after: multi-address to string — semicolon", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "z@blocked.example; y@partner.example",
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    expect(evaluateMailPolicy(input).rejectCode).toBe("mail_domain_denied");
  });

  test("before/after: display-name form hiding a denylisted address is rejected", () => {
    const input = {
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "Blocked Person <z@blocked.example>; y@partner.example",
    };
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
    expect(evaluateMailPolicy(input).rejectCode).toBe("mail_recipient_invalid");
  });

  test("after: multi-address string inside cc is parsed too", () => {
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "a@ok.example",
      cc: ["b@ok.example, z@blocked.example"],
    });
    expect(d.rejectCode).toBe("mail_domain_denied");
  });

  test("after: domain match is case-insensitive", () => {
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], CONSENT),
      to: "Z@BLOCKED.Example",
    });
    expect(d.rejectCode).toBe("mail_domain_denied");
  });

  test("after: all-allowed multi recipients under consented auto still auto-send (no over-blocking)", () => {
    const d = evaluateMailPolicy({
      policy: makePolicy([{ audience: "any", sendMode: "auto", toDomainAllowlist: ["partner.example"] }], CONSENT),
      to: "y@partner.example, w@partner.example",
      cc: ["v@partner.example"],
    });
    expect(canSendWithoutHuman(d)).toBe(true);
  });
});

describe("concern 3: recipients without a parseable domain are rejected (fail-closed)", () => {
  const policy = makePolicy([{ audience: "any", sendMode: "auto", toDomainAllowlist: ["partner.example"] }], CONSENT);

  test("before/after: to without a domain", () => {
    const legacy = legacyEvaluateMailPolicy({ policy, to: "not-an-address" });
    expect(legacy.rejected).toBe(false); // allowlist check was skipped
    const d = evaluateMailPolicy({ policy, to: "not-an-address" });
    expect(d.rejected).toBe(true);
    expect(d.rejectCode).toBe("mail_recipient_invalid");
  });

  test("after: invalid cc / bcc entries reject", () => {
    expect(evaluateMailPolicy({ policy, to: "y@partner.example", cc: ["bad"] }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "y@partner.example", bcc: ["x@"] }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "y@partner.example", cc: ["a@b@partner.example"] }).rejectCode).toBe("mail_recipient_invalid");
  });

  test("after: to that parses to zero addresses, or has empty segments, rejects", () => {
    expect(evaluateMailPolicy({ policy, to: " , ; " }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "" }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "y@partner.example," }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "y@partner.example;;w@partner.example" }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "Partner <y@partner.example>" }).rejectCode).toBe("mail_recipient_invalid");
    expect(evaluateMailPolicy({ policy, to: "y@localhost" }).rejectCode).toBe("mail_recipient_invalid");
  });

  test("after: malformed recipient containers from args reject", () => {
    const extracted = extractMailRecipients({ args: { cc: [{ email: "x@evil.example" }] } });
    expect(extracted.malformed).toBe(true);
    expect(extractMailRecipients({ args: { bcc: 42 } }).malformed).toBe(true);
    expect(extractMailRecipients({ args: { cc: ["a@ok.example"], bcc: "b@ok.example" } }).malformed).toBe(false);
    const d = evaluateMailPolicy({ policy, to: "y@partner.example", malformedRecipients: true });
    expect(d.rejectCode).toBe("mail_recipient_invalid");
  });
});

describe("concern 4: requireHumanFinalSend forces approval", () => {
  const input = {
    policy: makePolicy([{ audience: "any", sendMode: "auto", requireHumanFinalSend: true }], CONSENT),
    to: "x@customer.example",
  };

  test("before: requireHumanFinalSend was ignored (auto-sent)", () => {
    expect(canSendWithoutHuman(legacyEvaluateMailPolicy(input))).toBe(true);
  });

  test("after: approval required", () => {
    const d = evaluateMailPolicy(input);
    expect(d.autoSend).toBe(false);
    expect(d.needsApproval).toBe(true);
    expect(d.auditLabels).toContain("requireHumanFinalSend:true");
  });

  test("after: draft_only + requireHumanFinalSend stays draft (stricter kept)", () => {
    const d = evaluateMailPolicy({
      ...input,
      policy: makePolicy([{ audience: "any", sendMode: "draft_only", requireHumanFinalSend: true }], CONSENT),
    });
    expect(d.demotedToDraft).toBe(true);
  });
});

describe("monotonicity: hardened evaluator is never looser than legacy (main == #223)", () => {
  const P = (rules: Partial<MailPolicyRule>[], consent = true) => makePolicy(rules, consent ? CONSENT : {});
  const policies: OrgMailPolicy[] = [
    defaultMailPolicy(),
    P([{ audience: "internal", sendMode: "auto" }]),
    P([{ audience: "external", sendMode: "auto" }]),
    P([{ audience: "external", sendMode: "needs_approval" }]),
    P([{ audience: "any", sendMode: "auto" }]),
    P([{ audience: "any", sendMode: "auto" }], false),
    P([{ audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"] }]),
    P([
      { audience: "external", sendMode: "needs_approval", toDomainAllowlist: ["partner.example"] },
      { audience: "internal", sendMode: "auto" },
    ]),
    P([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["blocked.example"] }]),
    P([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }]),
    P([
      { audience: "internal", sendMode: "auto" },
      { audience: "external", sendMode: "draft_only" },
    ]),
    P([{ audience: "any", sendMode: "auto", requireHumanFinalSend: true }]),
    P([{ audience: "any", sendMode: "auto", allowCc: false, allowBcc: false }]),
    P([{ audience: "external", sendMode: "auto", attachmentPolicyRef: "forbid" }]),
    P([
      { audience: "internal", sendMode: "needs_approval", priority: 0 },
      { audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"], priority: 1 },
      { audience: "external", sendMode: "draft_only", priority: 2 },
    ]),
    P([
      { audience: "external", sendMode: "draft_only", priority: 5 },
      { audience: "any", sendMode: "auto", toDomainAllowlist: ["partner.example", "ourco.example"], priority: 1 },
    ]),
    { ...defaultMailPolicy(), rules: [] },
  ];
  const tos = [
    "a@ourco.example",
    "x@customer.example",
    "y@partner.example",
    "z@blocked.example",
    "Z@Blocked.Example",
    "not-an-address",
    "",
    "x@customer.example, y@partner.example",
    "y@partner.example; a@ourco.example",
    "Name <z@blocked.example>",
    "a@ourco.example,",
    ", a@ourco.example",
    "a@ourco.example;;x@customer.example",
    "Name <a@ourco.example>",
    "Partner <y@partner.example>",
    "a@ourco.example>",
    "a b@ourco.example",
    "a@ourco",
    "a@b@partner.example",
    "x@customer.example, a@ourco.example",
  ];
  const ccs: string[][] = [[], ["a@ourco.example"], ["z@blocked.example"], ["x@customer.example, y@partner.example"], ["bad"], ["Name <a@ourco.example>"]];
  const bccs: string[][] = [[], ["x@customer.example"], ["y@partner.example"]];
  const d1None: OrgIngressHandoffPolicy = {
    version: 1,
    policyId: "ihp_t",
    policyName: "D1",
    rules: [{ id: "r", applyTo: "all", body: "full", attachment: "none", sealith: "off", audit: { jobId: true, sealithTransferId: false } }],
    updatedAt: "2026-10-01T00:00:00Z",
    updatedBy: "admin_mcp",
  };

  test("rank(hardened) >= rank(legacy) for every combination", () => {
    let checked = 0;
    const looser: string[] = [];
    for (const [pi, policy] of policies.entries()) {
      for (const to of tos) {
        for (const cc of ccs) {
          for (const bcc of bccs) {
            for (const hasAttachments of [false, true]) {
              for (const ingressHandoffPolicy of [null, d1None]) {
                for (const internalAudienceRule of [INTERNAL, null]) {
                  const input = { policy, to, cc, bcc, hasAttachments, ingressHandoffPolicy, internalAudienceRule };
                  const before = rank(legacyEvaluateMailPolicy(input));
                  const after = rank(evaluateMailPolicy(input));
                  checked++;
                  if (after < before) looser.push(JSON.stringify({ pi, to, cc, bcc, hasAttachments, d1: !!ingressHandoffPolicy, internal: !!internalAudienceRule, before, after }));
                }
              }
            }
          }
        }
      }
    }
    expect(looser).toEqual([]);
    expect(checked).toBeGreaterThan(10000);
  });

  test("seeded fuzz over arbitrary to / cc strings: never looser than legacy", () => {
    let seed = 20261003;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const tokens = ["a", "x", "@", "@", "ourco.example", "partner.example", "blocked.example", "customer.example", ",", ";", " ", "<", ">", ".", "-", "\"", "A@OURCO.EXAMPLE"];
    const gen = () => Array.from({ length: 1 + Math.floor(next() * 7) }, () => tokens[Math.floor(next() * tokens.length)]).join("");
    const looser: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const policy = policies[Math.floor(next() * policies.length)];
      const to = gen();
      const cc = next() < 0.5 ? [] : [gen()];
      const bcc = next() < 0.7 ? [] : [gen()];
      const input = { policy, to, cc, bcc, internalAudienceRule: next() < 0.7 ? INTERNAL : null };
      if (rank(evaluateMailPolicy(input)) < rank(legacyEvaluateMailPolicy(input))) looser.push(JSON.stringify({ to, cc, bcc }));
    }
    expect(looser).toEqual([]);
  });
});
