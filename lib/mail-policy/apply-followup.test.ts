/**
 * Mail policy follow-up (after #223 / #227), pure evaluator level.
 * - item 1: every primary recipient field (to / recipient / email /
 *   body.email / conversation.email) is judged, not only the first one.
 * - item 2: denylist entries also match subdomains on an exact label boundary.
 *
 * Each item has a "before: could send" reproduction against the frozen main
 * evaluator (__fixtures__/legacy-apply-a72c9f8.ts, i.e. main after #227) and
 * an "after" assertion. The differential grid + seeded fuzz prove the new
 * pipeline is never looser than main for any input in the grid.
 * Dummy domains only.
 */
import { describe, expect, test } from "bun:test";
import {
  collectMailToRecipients,
  evaluateMailPolicy,
  extractMailRecipients,
  isDomainDenylisted,
} from "./apply";
import {
  evaluateMailPolicy as mainEvaluateMailPolicy,
  extractMailRecipients as mainExtractMailRecipients,
} from "./__fixtures__/legacy-apply-a72c9f8";
import { defaultMailPolicy, normalizeMailPolicy } from "./validate";
import type {
  MailPolicyDecision,
  MailPolicyRule,
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
  updatedBy: "admin_mcp",
};

function makePolicy(rules: Partial<MailPolicyRule>[], consent = true): OrgMailPolicy {
  return normalizeMailPolicy({
    policyId: "mpp_followup_test",
    policyName: "Followup Test",
    rules: rules.map((r, i) => ({ id: `mpr_${i}`, sendMode: "draft_only", ...r })),
    ...(consent ? CONSENT : {}),
  });
}

function rank(d: Pick<MailPolicyDecision, "rejected" | "demotedToDraft" | "needsApproval" | "autoSend">): number {
  if (d.rejected) return 4;
  if (d.demotedToDraft) return 3;
  if (d.needsApproval) return 2;
  if (!d.autoSend) return 1;
  return 0;
}

type Body = {
  args: Record<string, unknown>;
  email?: unknown;
  conversation?: { email?: unknown } | null;
};

/**
 * main's invoke pipeline: validateMailSendArtifact picks the FIRST string
 * field (to → recipient → email → body.email → conversation.email) and only
 * that one reaches evaluateMailPolicy. Returns null when main answers 400
 * (empty primary) — that validation is unchanged on this branch.
 */
function mainPipeline(policy: OrgMailPolicy, body: Body, internalAudienceRule: OrgInternalAudienceRule | null) {
  const a = body.args;
  const to = String(
    typeof a.to === "string" ? a.to :
    typeof a.recipient === "string" ? a.recipient :
    typeof a.email === "string" ? a.email :
    typeof body.email === "string" ? body.email :
    body.conversation?.email ?? ""
  ).trim();
  if (!to) return null;
  const r = mainExtractMailRecipients({ args: a });
  return mainEvaluateMailPolicy({
    policy,
    to,
    cc: r.cc,
    bcc: r.bcc,
    hasAttachments: r.hasAttachments,
    malformedRecipients: r.malformed,
    internalAudienceRule,
  });
}

/** This branch: same validation, then every primary field is judged. */
function newPipeline(policy: OrgMailPolicy, body: Body, internalAudienceRule: OrgInternalAudienceRule | null) {
  const primary = collectMailToRecipients(body);
  const r = extractMailRecipients({ args: body.args });
  return evaluateMailPolicy({
    policy,
    to: primary.to,
    cc: r.cc,
    bcc: r.bcc,
    hasAttachments: r.hasAttachments,
    malformedRecipients: r.malformed || primary.malformed,
    internalAudienceRule,
  });
}

describe("item 1: every primary recipient field is judged", () => {
  const denyBlocked = makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }]);
  const internalAuto = makePolicy([
    { audience: "internal", sendMode: "auto" },
    { audience: "external", sendMode: "draft_only" },
  ]);

  test("collectMailToRecipients keeps every field in legacy order, de-duplicated", () => {
    const c = collectMailToRecipients({
      args: { to: "a@ourco.example", recipient: "z@blocked.example", email: "a@ourco.example" },
      email: "x@customer.example",
      conversation: { email: "y@partner.example" },
    });
    expect(c.sources).toEqual(["a@ourco.example", "z@blocked.example", "x@customer.example", "y@partner.example"]);
    expect(c.to).toBe("a@ourco.example, z@blocked.example, x@customer.example, y@partner.example");
    expect(c.malformed).toBe(false);
  });

  test("collectMailToRecipients flags a non-string body.email / conversation.email", () => {
    expect(collectMailToRecipients({ args: { to: "a@ourco.example" }, email: ["z@blocked.example"] }).malformed).toBe(true);
    expect(collectMailToRecipients({ args: { to: "a@ourco.example" }, conversation: { email: 1 } }).malformed).toBe(true);
    expect(collectMailToRecipients({ args: { to: "a@ourco.example" }, conversation: { email: null } }).malformed).toBe(false);
  });

  test("before/after: denied address in `recipient` behind a clean `to`", () => {
    const body = { args: { to: "buyer@customer.example", recipient: "z@blocked.example" } };
    const before = mainPipeline(denyBlocked, body, INTERNAL)!;
    expect(before.autoSend).toBe(true); // main: only `to` judged → auto-sent
    const after = newPipeline(denyBlocked, body, INTERNAL);
    expect(after.rejected).toBe(true);
    expect(after.rejectCode).toBe("mail_domain_denied");
  });

  test("before/after: external `email` behind an internal `to` makes the mail external", () => {
    const body = { args: { to: "a@ourco.example", email: "x@customer.example" } };
    const before = mainPipeline(internalAuto, body, INTERNAL)!;
    expect(before.autoSend).toBe(true); // main: internal auto
    const after = newPipeline(internalAuto, body, INTERNAL);
    expect(after.audience).toBe("external");
    expect(after.demotedToDraft).toBe(true);
  });

  test("before/after: body.email / conversation.email are judged too", () => {
    for (const body of [
      { args: { to: "buyer@customer.example" }, email: "z@blocked.example" },
      { args: { to: "buyer@customer.example" }, conversation: { email: "z@blocked.example" } },
    ]) {
      expect(mainPipeline(denyBlocked, body, INTERNAL)!.autoSend).toBe(true);
      expect(newPipeline(denyBlocked, body, INTERNAL).rejectCode).toBe("mail_domain_denied");
    }
  });

  test("after: an unparseable secondary field rejects (fail-closed)", () => {
    const after = newPipeline(denyBlocked, { args: { to: "buyer@customer.example", recipient: "bob" } }, INTERNAL);
    expect(after.rejectCode).toBe("mail_recipient_invalid");
  });

  test("control: a single `to` behaves exactly like main", () => {
    const body = { args: { to: "buyer@customer.example" } };
    expect(newPipeline(denyBlocked, body, INTERNAL)).toEqual(mainPipeline(denyBlocked, body, INTERNAL)!);
  });
});

describe("item 2: denylist matches subdomains on an exact label boundary", () => {
  const policy = makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }]);

  test("isDomainDenylisted: label boundary, not substring", () => {
    expect(isDomainDenylisted("blocked.example", ["blocked.example"])).toBe(true);
    expect(isDomainDenylisted("mail.blocked.example", ["blocked.example"])).toBe(true);
    expect(isDomainDenylisted("a.b.blocked.example", ["blocked.example"])).toBe(true);
    expect(isDomainDenylisted("badblocked.example", ["blocked.example"])).toBe(false);
    expect(isDomainDenylisted("blocked.example.evil", ["blocked.example"])).toBe(false);
    expect(isDomainDenylisted("blocked-example", ["blocked.example"])).toBe(false);
    expect(isDomainDenylisted("example", ["blocked.example"])).toBe(false);
    expect(isDomainDenylisted("x.example", ["blocked.example"])).toBe(false);
  });

  test("isDomainDenylisted: tolerant entry forms only widen the deny side", () => {
    for (const entry of ["Blocked.Example", "@blocked.example", "*.blocked.example", ".blocked.example", "blocked.example.", " blocked.example "]) {
      expect(isDomainDenylisted("mail.blocked.example", [entry])).toBe(true);
      expect(isDomainDenylisted("blocked.example", [entry])).toBe(true);
      expect(isDomainDenylisted("badblocked.example", [entry])).toBe(false);
    }
    expect(isDomainDenylisted("blocked.example", ["", "  ", "*.", "@", 42 as unknown as string])).toBe(false);
  });

  test("before/after: subdomain of a denied domain", () => {
    const input = { policy, to: "x@mail.blocked.example", internalAudienceRule: INTERNAL };
    expect(mainEvaluateMailPolicy(input).autoSend).toBe(true); // main: exact match only → auto-sent
    const after = evaluateMailPolicy(input);
    expect(after.rejected).toBe(true);
    expect(after.rejectCode).toBe("mail_domain_denied");
  });

  test("before/after: subdomain in cc / bcc", () => {
    for (const extra of [{ cc: ["c@eu.blocked.example"] }, { bcc: ["b@eu.blocked.example"] }]) {
      const input = { policy, to: "buyer@customer.example", internalAudienceRule: INTERNAL, ...extra };
      expect(mainEvaluateMailPolicy(input).autoSend).toBe(true);
      expect(evaluateMailPolicy(input).rejectCode).toBe("mail_domain_denied");
    }
  });

  test("after: a lookalike (badblocked.example) is NOT denied", () => {
    const after = evaluateMailPolicy({ policy, to: "x@badblocked.example", internalAudienceRule: INTERNAL });
    expect(after.rejected).toBe(false);
    expect(after.autoSend).toBe(true);
  });

  test("after: allowlist stays exact (subdomain of an allowed domain is still not allowed)", () => {
    const allow = makePolicy([{ audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"] }]);
    const sub = evaluateMailPolicy({ policy: allow, to: "x@sub.partner.example", internalAudienceRule: INTERNAL });
    expect(sub.autoSend).toBe(false);
    expect(rank(sub)).toBeGreaterThanOrEqual(rank(mainEvaluateMailPolicy({ policy: allow, to: "x@sub.partner.example", internalAudienceRule: INTERNAL })));
  });

  test("after: a subdomain deny on an earlier rule wins over a later auto rule", () => {
    const p = makePolicy([
      { audience: "any", sendMode: "needs_approval", toDomainDenylist: ["blocked.example"], priority: 0 },
      { audience: "any", sendMode: "auto", priority: 1 },
    ]);
    expect(evaluateMailPolicy({ policy: p, to: "x@mx.blocked.example", internalAudienceRule: INTERNAL }).rejectCode).toBe("mail_domain_denied");
  });
});

// The exhaustive grid takes ~4.4s alone and went past bun's default 5s under
// the full suite's load. Only the timeout is raised: same grid, same seed,
// same iteration counts, same assertions.
const DIFFERENTIAL_TIMEOUT_MS = 60_000;
// bun:test takes a per-test timeout as the 3rd argument; the local
// bun-test.d.ts shim only declares (name, fn), so widen the type here.
const slowTest = test as unknown as (name: string, fn: () => unknown, timeoutMs: number) => void;

describe("differential: new pipeline is never looser than main (a72c9f8)", () => {
  const policies: OrgMailPolicy[] = [
    defaultMailPolicy(),
    { ...defaultMailPolicy(), rules: [] },
    makePolicy([{ audience: "any", sendMode: "auto" }]),
    makePolicy([{ audience: "any", sendMode: "auto" }], false),
    makePolicy([{ audience: "internal", sendMode: "auto" }]),
    makePolicy([{ audience: "external", sendMode: "auto" }]),
    makePolicy([{ audience: "external", sendMode: "needs_approval" }]),
    makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }]),
    makePolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["blocked.example"] }]),
    makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["Blocked.Example", "*.evil.example"] }]),
    makePolicy([{ audience: "external", sendMode: "auto", toDomainDenylist: ["example"] }]),
    makePolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["ourco.example"] }]),
    makePolicy([{ audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example"] }]),
    makePolicy([
      { audience: "external", sendMode: "auto", toDomainAllowlist: ["partner.example", "sub.partner.example"], toDomainDenylist: ["blocked.example"] },
      { audience: "internal", sendMode: "auto" },
    ]),
    makePolicy([
      { audience: "any", sendMode: "needs_approval", toDomainDenylist: ["blocked.example"], priority: 0 },
      { audience: "any", sendMode: "auto", priority: 1 },
    ]),
    makePolicy([
      { audience: "internal", sendMode: "auto" },
      { audience: "external", sendMode: "draft_only" },
    ]),
    makePolicy([{ audience: "any", sendMode: "auto", allowCc: false }]),
    makePolicy([{ audience: "any", sendMode: "auto", requireHumanFinalSend: true }]),
  ];
  const values: Array<string | undefined> = [
    undefined,
    "",
    "a@ourco.example",
    "a@sub.ourco.example",
    "x@customer.example",
    "y@partner.example",
    "y@sub.partner.example",
    "z@blocked.example",
    "z@mail.blocked.example",
    "z@badblocked.example",
    "q@a.evil.example",
    "bob",
    "x@customer.example, z@mail.blocked.example",
  ];
  const convValues: Array<string | undefined> = [undefined, "a@ourco.example", "z@mx.blocked.example"];
  const ccs: unknown[] = [undefined, ["c@eu.blocked.example"], ["a@ourco.example"]];

  slowTest("rank(new) >= rank(main) for every combination", () => {
    let checked = 0;
    const looser: string[] = [];
    for (const [pi, policy] of policies.entries()) {
      for (const to of values) {
        for (const recipient of values) {
          for (const email of [undefined, "x@customer.example", "z@sub.blocked.example"]) {
            for (const bodyEmail of convValues) {
              for (const convEmail of convValues) {
                for (const cc of ccs) {
                  for (const internal of [INTERNAL, null]) {
                    const args: Record<string, unknown> = { to, recipient, email, cc };
                    for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
                    const body: Body = { args, email: bodyEmail, conversation: convEmail ? { email: convEmail } : null };
                    const before = mainPipeline(policy, body, internal);
                    if (!before) continue; // main 400 (empty primary) — validation unchanged
                    const after = newPipeline(policy, body, internal);
                    checked++;
                    if (rank(after) < rank(before)) {
                      looser.push(JSON.stringify({ pi, body, internal: !!internal, before: rank(before), after: rank(after) }));
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(looser).toEqual([]);
    expect(checked).toBeGreaterThan(100000);
  }, DIFFERENTIAL_TIMEOUT_MS);

  slowTest("seeded fuzz over arbitrary recipient strings / subdomains: never looser than main", () => {
    let seed = 20261003;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const tokens = ["a", "x", "@", "@", "ourco.example", "blocked.example", "mail.", "bad", "partner.example", "sub.", ".", ",", ";", " ", "-", "Blocked.", "EXAMPLE"];
    const gen = () => Array.from({ length: 1 + Math.floor(next() * 7) }, () => tokens[Math.floor(next() * tokens.length)]).join("");
    const looser: string[] = [];
    let checked = 0;
    for (let i = 0; i < 30000; i++) {
      const policy = policies[Math.floor(next() * policies.length)];
      const args: Record<string, unknown> = { to: gen() };
      if (next() < 0.5) args.recipient = gen();
      if (next() < 0.3) args.email = gen();
      if (next() < 0.4) args.cc = [gen()];
      const body: Body = { args, email: next() < 0.2 ? gen() : undefined, conversation: next() < 0.2 ? { email: gen() } : null };
      const internal = next() < 0.7 ? INTERNAL : null;
      const before = mainPipeline(policy, body, internal);
      if (!before) continue;
      checked++;
      if (rank(newPipeline(policy, body, internal)) < rank(before)) looser.push(JSON.stringify(body));
    }
    expect(looser).toEqual([]);
    expect(checked).toBeGreaterThan(20000);
  }, DIFFERENTIAL_TIMEOUT_MS);
});
