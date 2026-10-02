import { describe, expect, test } from "bun:test";
import { maskEmail, scoreSpamFacts, type SpamFacts } from "./score";

const now = new Date("2026-10-03T00:00:00Z");
function facts(over: Partial<SpamFacts> = {}): SpamFacts {
  return {
    orgId: "11111111-1111-4111-8111-111111111111",
    orgName: "株式会社サンプル商事",
    orgCreatedAt: "2026-09-20T00:00:00Z",
    referralCode: "QWERTYUIOPASDF",
    stripeCustomerId: null,
    hasStripeSubscription: false,
    memberCount: 1,
    employeeCount: 0,
    sameName24h: 3,
    ownerMemberId: null,
    ownerUserId: null,
    ownerMemberStatus: "active",
    ownerEmail: "s.o.m.e.o.n.e@gmail.com",
    userCreatedAt: "2026-09-20T00:00:00Z",
    lastSignInAt: "2026-09-20T00:00:01Z",
    bannedUntil: null,
    signupSignals: [],
    signupIpReuse: 0,
    ...over,
  };
}

describe("scoreSpamFacts", () => {
  test("2026-09 bot wave pattern scores as candidate (>= 90)", () => {
    const s = scoreSpamFacts(facts(), now);
    expect(s.band).toBe("candidate");
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(s.signals.map((x) => x.code)).toContain("default_org_name");
    expect(s.signals.map((x) => x.code)).toContain("referral_not_aic");
  });

  test("legit org (custom name, AIC referral, employees) is ok", () => {
    const s = scoreSpamFacts(facts({ orgName: "スペースツリー", referralCode: "AIC-TOKYO307", employeeCount: 2, sameName24h: 1, ownerEmail: "a@spacetree.jp" }), now);
    expect(s.band).toBe("ok");
    expect(s.score).toBe(0);
  });

  test("billing is a hard negative", () => {
    const s = scoreSpamFacts(facts({ stripeCustomerId: "cus_x" }), now);
    expect(s.band).toBe("ok");
  });

  test("no referral + default name is watch, not candidate", () => {
    const s = scoreSpamFacts(facts({ referralCode: null, sameName24h: 1, ownerEmail: "x@example.co.jp", lastSignInAt: null }), now);
    expect(s.band).toBe("watch");
  });
});

describe("maskEmail", () => {
  test("never returns the full local part", () => {
    expect(maskEmail("someone5@gmail.com")).toBe("so***5@gmail.com");
    expect(maskEmail("ab@x.jp")).toBe("ab***@x.jp");
    expect(maskEmail("")).toBe("***");
    expect(maskEmail("nodomain")).toBe("***");
  });
});
