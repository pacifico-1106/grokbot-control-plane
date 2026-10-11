import { describe, expect, test } from "bun:test";
import {
  CHANNEL_CLASSIFICATIONS,
  CHANNEL_LEDGER_SURFACES,
  PARTY_AUDIENCES,
  PARTY_KINDS,
  buildChannelProposal,
  buildUnregisteredDenyNoticeJa,
  channelFactsHash,
  describeSharingJa,
  suggestClassification,
  validateChannelsClassifyArgs,
  validatePartiesUpsertArgs,
  type ChannelFacts,
} from "@/lib/channel-classify/core";

function slackFacts(over: Partial<ChannelFacts> = {}): ChannelFacts {
  return {
    surface: "slack",
    externalId: "C0TESTCHAN1",
    conversationType: "public_channel",
    isPrivate: false,
    isShared: false,
    isExtShared: false,
    isIm: false,
    isMpim: false,
    memberCount: 3,
    internalMembers: 3,
    externalMembers: 0,
    guestMembers: 0,
    membersComplete: true,
    internalMemberIds: ["U0AAA", "U0BBB", "U0CCC"],
    ...over,
  };
}

describe("validateChannelsClassifyArgs (request-time, outside the flag)", () => {
  test("valid args normalise (surface default slack, classification default unknown)", () => {
    const ok = validateChannelsClassifyArgs({ externalId: " C0TESTCHAN1 " });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toMatchObject({ surface: "slack", externalId: "C0TESTCHAN1", classification: "unknown", mixed: false });
    const tg = validateChannelsClassifyArgs({ surface: "telegram", externalId: "-1001234", classification: "shared_external", mixed: true });
    expect(tg.ok).toBe(true);
  });

  test("typo in classification is rejected with code, allowed values and nextStep", () => {
    const bad = validateChannelsClassifyArgs({ externalId: "C0TESTCHAN1", classification: "internl" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid_classification");
      expect(bad.field).toBe("classification");
      expect(bad.allowed).toEqual([...CHANNEL_CLASSIFICATIONS]);
      expect(bad.nextStep).toContain("channels.classify");
      expect(bad.nextStepJa.length).toBeGreaterThan(0);
    }
  });

  test("invalid surface / missing externalId / non-boolean mixed rejected", () => {
    const s = validateChannelsClassifyArgs({ externalId: "C1", surface: "slak" });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.code).toBe("invalid_surface");
      expect(s.allowed).toEqual([...CHANNEL_LEDGER_SURFACES]);
    }
    const e = validateChannelsClassifyArgs({ classification: "internal" });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.code).toBe("external_id_required");
    const m = validateChannelsClassifyArgs({ externalId: "C1", mixed: "yes" });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.code).toBe("invalid_mixed");
  });

  test("received value is echoed only as a short sanitized code (no markup)", () => {
    const bad = validateChannelsClassifyArgs({ externalId: "C1", classification: "<script>x</script>".repeat(10) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.received?.includes("<")).toBe(false);
      expect((bad.received || "").length).toBeLessThanOrEqual(40);
    }
  });
});

describe("validatePartiesUpsertArgs", () => {
  test("valid kind / audience", () => {
    const ok = validatePartiesUpsertArgs({ kind: "slack_user", identifier: "U0AAA", audience: "internal" });
    expect(ok.ok).toBe(true);
    const dflt = validatePartiesUpsertArgs({ kind: "email_domain", identifier: "example.com" });
    expect(dflt.ok).toBe(true);
    if (dflt.ok) expect(dflt.value.audience).toBe("external");
  });

  test("invalid kind / audience rejected with allowed lists", () => {
    const k = validatePartiesUpsertArgs({ kind: "slack-user", identifier: "U0AAA" });
    expect(k.ok).toBe(false);
    if (!k.ok) {
      expect(k.code).toBe("invalid_kind");
      expect(k.allowed).toEqual([...PARTY_KINDS]);
      expect(k.nextStep).toContain("parties.upsert");
    }
    const a = validatePartiesUpsertArgs({ kind: "slack_user", identifier: "U0AAA", audience: "internl" });
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.code).toBe("invalid_audience");
      expect(a.allowed).toEqual([...PARTY_AUDIENCES]);
    }
    const i = validatePartiesUpsertArgs({ kind: "slack_user", identifier: "  " });
    expect(i.ok).toBe(false);
    if (!i.ok) expect(i.code).toBe("identifier_required");
  });
});

describe("suggestClassification", () => {
  test("verified internal (complete member list, no guests / external, not shared) → internal", () => {
    expect(suggestClassification(slackFacts())).toEqual({ classification: "internal", mixed: false, basis: "verified_internal" });
  });

  test("Slack Connect / external members / guests → shared_external mixed", () => {
    expect(suggestClassification(slackFacts({ isExtShared: true, isShared: true })).classification).toBe("shared_external");
    expect(suggestClassification(slackFacts({ externalMembers: 1 })).basis).toBe("external_present");
    expect(suggestClassification(slackFacts({ guestMembers: 1 })).mixed).toBe(true);
  });

  test("incomplete member inspection or LINE / Telegram → unverified (never internal)", () => {
    expect(suggestClassification(slackFacts({ membersComplete: false })).basis).toBe("unverified");
    const line = suggestClassification({ ...slackFacts(), surface: "line", conversationType: "group", membersComplete: false, internalMembers: null, externalMembers: null, guestMembers: null });
    expect(line.classification).toBe("shared_external");
    expect(line.basis).toBe("unverified");
  });
});

describe("facts hash and proposal shape", () => {
  test("hash is stable for member id order and changes with sharing facts", () => {
    const a = channelFactsHash(slackFacts());
    const b = channelFactsHash(slackFacts({ internalMemberIds: ["U0CCC", "U0AAA", "U0BBB"] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(channelFactsHash(slackFacts({ isExtShared: true }))).not.toBe(a);
  });

  test("internal channel → one channels.classify ticket, no parties", () => {
    const p = buildChannelProposal(slackFacts(), { registeredPartyIds: new Set(), maxParties: 5 });
    expect(p.classify.tool).toBe("channels.classify");
    expect(p.classify.args).toEqual({ surface: "slack", externalId: "C0TESTCHAN1", classification: "internal", mixed: false });
    expect(p.parties).toEqual([]);
  });

  test("mixed channel → classify shared_external + parties.upsert for unregistered internal members (capped)", () => {
    const facts = slackFacts({ externalMembers: 2, memberCount: 5, internalMemberIds: ["U0AAA", "U0BBB", "U0CCC"] });
    const p = buildChannelProposal(facts, { registeredPartyIds: new Set(["U0BBB"]), maxParties: 1 });
    expect(p.classify.args).toMatchObject({ classification: "shared_external", mixed: true });
    expect(p.parties.length).toBe(1);
    expect(p.parties[0].tool).toBe("parties.upsert");
    expect(p.parties[0].args).toEqual({ kind: "slack_user", identifier: "U0AAA", audience: "internal" });
    expect(p.partiesTruncated).toBe(true);
  });

  test("IM is never proposed (DM routes have their own flow)", () => {
    const p = buildChannelProposal(slackFacts({ isIm: true, conversationType: "im", externalId: "D0TESTIM" }), { registeredPartyIds: new Set(), maxParties: 5 });
    expect(p.skip).toBe("im_not_proposed");
  });
});

describe("wording", () => {
  test("sharing description names Connect / guests / external members", () => {
    const text = describeSharingJa(slackFacts({ isExtShared: true, guestMembers: 2, externalMembers: 3 }));
    expect(text).toContain("Slack Connect");
    expect(text).toContain("ゲスト");
    expect(text).toContain("2");
    expect(describeSharingJa({ ...slackFacts(), surface: "line", membersComplete: false, internalMembers: null, externalMembers: null, guestMembers: null })).toContain("確認できません");
  });

  test("deny notice: channel, reason, one-tap fix; no message body, not tied to one agent product", () => {
    const text = buildUnregisteredDenyNoticeJa({
      ref: { surface: "slack", externalId: "C0TESTCHAN1" },
      reason: "external_confidential_denied",
      approvalId: "appr_123",
      proposalState: "created",
    });
    expect(text).toContain("C0TESTCHAN1");
    expect(text).toContain("external_confidential_denied");
    expect(text).toContain("appr_123");
    expect(text).toContain("channels.classify");
    expect(/grok/i.test(text)).toBe(false);
  });
});
