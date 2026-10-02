import { describe, expect, test } from "bun:test";
import {
  classifySlackConversation,
  isChannelInScope,
  isConnectTeamAllowed,
  isRegisteredChannel,
  mergeAutoClassification,
  resolveEffectiveChannelScope,
} from "./resolve";
import type { ChannelScopeChannel, ChannelScopeFlags, EffectiveChannelScope, MembershipState } from "./types";

const ON: ChannelScopeFlags = { enabled: true, connectEnabled: true };
const ON_NO_CONNECT: ChannelScopeFlags = { enabled: true, connectEnabled: false };
const OFF: ChannelScopeFlags = { enabled: false, connectEnabled: true };

const orgAllJoined = { version: 1, mode: "all_joined", includeSlackConnect: false };
const empConnect = { version: 1, mode: "all_joined", includeSlackConnect: true };

describe("resolveEffectiveChannelScope (employee > org > default)", () => {
  test("flag OFF ⇒ registered_only regardless of stored policies", () => {
    const s = resolveEffectiveChannelScope({ employeeOverride: empConnect, orgPolicy: orgAllJoined, flags: OFF });
    expect(s.policy.mode).toBe("registered_only");
    expect(s.policy.includeSlackConnect).toBe(false);
    expect(s.source).toBe("default");
  });

  test("employee override wins", () => {
    const s = resolveEffectiveChannelScope({ employeeOverride: empConnect, orgPolicy: { mode: "registered_only" }, flags: ON });
    expect(s.source).toBe("employee");
    expect(s.policy.mode).toBe("all_joined");
    expect(s.policy.includeSlackConnect).toBe(true);
  });

  test("org default used when no employee override", () => {
    const s = resolveEffectiveChannelScope({ employeeOverride: null, orgPolicy: orgAllJoined, flags: ON });
    expect(s.source).toBe("org");
    expect(s.policy.mode).toBe("all_joined");
  });

  test("safe default registered_only when nothing stored", () => {
    const s = resolveEffectiveChannelScope({ flags: ON });
    expect(s.source).toBe("default");
    expect(s.policy.mode).toBe("registered_only");
    expect(s.invalidStoredPolicy).toBe(false);
  });

  test("invalid employee override ⇒ safe default (does not fall through to a wider org policy)", () => {
    const s = resolveEffectiveChannelScope({ employeeOverride: { mode: "bogus" }, orgPolicy: empConnect, flags: ON });
    expect(s.source).toBe("default");
    expect(s.policy.mode).toBe("registered_only");
    expect(s.invalidStoredPolicy).toBe(true);
  });

  test("invalid org policy ⇒ safe default", () => {
    const s = resolveEffectiveChannelScope({ orgPolicy: { mode: "registered_only", includeSlackConnect: true }, flags: ON });
    expect(s.policy.mode).toBe("registered_only");
    expect(s.invalidStoredPolicy).toBe(true);
  });

  test("Connect kill switch forces includeSlackConnect=false (separate boolean)", () => {
    const s = resolveEffectiveChannelScope({ employeeOverride: empConnect, flags: ON_NO_CONNECT });
    expect(s.policy.mode).toBe("all_joined");
    expect(s.policy.includeSlackConnect).toBe(false);
    expect(s.connectSuppressed).toBe(true);
  });

  test("reads env flags by default (both OFF in tests)", () => {
    const prev = [process.env.P1_CHANNEL_SCOPE_ENABLED, process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED];
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
    try {
      const s = resolveEffectiveChannelScope({ employeeOverride: empConnect });
      expect(s.flags).toEqual({ enabled: false, connectEnabled: false });
      expect(s.policy.mode).toBe("registered_only");
      process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
      const s2 = resolveEffectiveChannelScope({ employeeOverride: empConnect });
      expect(s2.policy.mode).toBe("all_joined");
      expect(s2.policy.includeSlackConnect).toBe(false);
      process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "true";
      expect(resolveEffectiveChannelScope({ employeeOverride: empConnect }).policy.includeSlackConnect).toBe(true);
    } finally {
      if (prev[0] === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED; else process.env.P1_CHANNEL_SCOPE_ENABLED = prev[0];
      if (prev[1] === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED; else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = prev[1];
    }
  });
});

const scope = (policy: unknown, flags = ON): EffectiveChannelScope =>
  resolveEffectiveChannelScope({ orgPolicy: policy, flags });

const ch = (over: Partial<ChannelScopeChannel> = {}): ChannelScopeChannel => ({
  externalId: "C0AAA",
  classification: "internal",
  mixed: false,
  source: "manual",
  externalTeamIds: [],
  humanConfirmedAt: null,
  ...over,
});
const mem = (state: MembershipState, via: "user" | "bot" = "user", externalId = "C0AAA") => ({
  surface: "slack" as const,
  externalId,
  state,
  via,
});

describe("isChannelInScope", () => {
  test("flag OFF ⇒ not enforced (legacy behavior)", () => {
    const d = isChannelInScope({ scope: scope(orgAllJoined, OFF), surface: "slack", externalId: "C0AAA", channel: null });
    expect(d.enforced).toBe(false);
    expect(d.reason).toBe("flag_off_legacy");
  });

  describe("registered_only", () => {
    const s = scope(null);
    test("manual row ⇒ in", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch() })).toMatchObject({ enforced: true, inScope: true, reason: "registered" });
    });
    test("legacy row without source column ⇒ treated as manual", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ source: undefined }) }).inScope).toBe(true);
    });
    test("manual Connect row stays in (human registered it)", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ classification: "shared_external", mixed: true }) }).inScope).toBe(true);
    });
    test("no row ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: null }).reason).toBe("not_registered");
    });
    test("unknown classification ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ classification: "unknown" }) }).reason).toBe("registered_unclassified");
    });
    test("auto_join without human confirmation ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ source: "auto_join" }) }).reason).toBe("auto_not_confirmed");
    });
    test("auto_join with human confirmation ⇒ in", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ source: "auto_join", humanConfirmedAt: "2026-10-02T00:00:00Z" }) }).inScope).toBe(true);
    });
    test("memberships are ignored", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch(), memberships: [mem("left")] }).inScope).toBe(true);
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: null, memberships: [mem("member")] }).inScope).toBe(false);
    });
    test("non-slack surface ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "line", externalId: "C0AAA", channel: ch() }).reason).toBe("surface_not_in_scope");
    });
  });

  describe("all_joined (internal only)", () => {
    const s = scope(orgAllJoined);
    const auto = ch({ source: "auto_join" });
    test("member + internal ⇒ in", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: auto, memberships: [mem("member")] }).reason).toBe("joined_internal");
    });
    test("member + unknown ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch({ source: "auto_join", classification: "unknown" }), memberships: [mem("member")] }).reason).toBe("classification_unknown");
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: null, memberships: [mem("member")] }).reason).toBe("classification_unknown");
    });
    test("member + Connect ⇒ out without includeSlackConnect", () => {
      const c = ch({ source: "auto_join", classification: "shared_external", mixed: true });
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: c, memberships: [mem("member")] }).reason).toBe("connect_not_included");
    });
    test("internal but mixed is treated as Connect", () => {
      const c = ch({ source: "auto_join", mixed: true });
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: c, memberships: [mem("member")] }).inScope).toBe(false);
    });
    test("not a member (auto row) ⇒ out", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: auto, memberships: [] }).reason).toBe("not_member");
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: auto, memberships: [mem("out_of_scope")] }).reason).toBe("not_member");
    });
    test("membership of another channel does not count", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: auto, memberships: [mem("member", "user", "C0BBB")] }).inScope).toBe(false);
    });
    test("left / removed ⇒ out even when registered", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch(), memberships: [mem("left")] }).reason).toBe("membership_left");
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch(), memberships: [mem("removed", "bot")] }).reason).toBe("membership_left");
    });
    test("bot removed but user still member ⇒ still in", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: auto, memberships: [mem("removed", "bot"), mem("member", "user")] }).inScope).toBe(true);
    });
    test("registered channel without membership rows stays in (no regression vs registered_only)", () => {
      expect(isChannelInScope({ scope: s, surface: "slack", externalId: "C0AAA", channel: ch(), memberships: [] }).reason).toBe("registered");
    });
  });

  describe("all_joined + includeSlackConnect", () => {
    const connect = ch({ source: "auto_join", classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] });
    test("Connect member ⇒ in", () => {
      expect(isChannelInScope({ scope: scope(empConnect), surface: "slack", externalId: "C0AAA", channel: connect, memberships: [mem("member")] }).reason).toBe("joined_connect");
    });
    test("Connect kill switch OFF ⇒ out", () => {
      expect(isChannelInScope({ scope: scope(empConnect, ON_NO_CONNECT), surface: "slack", externalId: "C0AAA", channel: connect, memberships: [mem("member")] }).reason).toBe("connect_not_included");
    });
    test("allowedExternalTeamIds restricts peers", () => {
      const allow = (ids: string[]) => scope({ ...empConnect, connect: { allowedExternalTeamIds: ids } });
      expect(isChannelInScope({ scope: allow(["T0PEER"]), surface: "slack", externalId: "C0AAA", channel: connect, memberships: [mem("member")] }).inScope).toBe(true);
      expect(isChannelInScope({ scope: allow(["T0OTHER"]), surface: "slack", externalId: "C0AAA", channel: connect, memberships: [mem("member")] }).reason).toBe("connect_team_not_allowed");
      const unknownPeers = { ...connect, externalTeamIds: [] };
      expect(isChannelInScope({ scope: allow(["T0PEER"]), surface: "slack", externalId: "C0AAA", channel: unknownPeers, memberships: [mem("member")] }).reason).toBe("connect_team_not_allowed");
    });
  });
});

describe("isConnectTeamAllowed / isRegisteredChannel", () => {
  test("empty allowlist allows any; mixed allowed/unallowed peers ⇒ not allowed", () => {
    const p = resolveEffectiveChannelScope({ orgPolicy: { ...empConnect, connect: { allowedExternalTeamIds: ["T0A1"] } }, flags: ON }).policy;
    expect(isConnectTeamAllowed(resolveEffectiveChannelScope({ orgPolicy: empConnect, flags: ON }).policy, [])).toBe(true);
    expect(isConnectTeamAllowed(p, ["t0a1"])).toBe(true);
    expect(isConnectTeamAllowed(p, ["T0A1", "T0B2"])).toBe(false);
  });
  test("registered requires classification and human provenance", () => {
    expect(isRegisteredChannel(null)).toBe(false);
    expect(isRegisteredChannel(ch({ source: "egress_inspect" }))).toBe(false);
    expect(isRegisteredChannel(ch({ source: "reconcile", humanConfirmedAt: "x" }))).toBe(true);
  });
});

describe("classifySlackConversation", () => {
  const IAR = ["T0HOME", "T0SISTER"];
  test("API failure ⇒ unknown", () => {
    expect(classifySlackConversation(null, IAR)).toMatchObject({ classification: "unknown", basis: "api_failed" });
    expect(classifySlackConversation({}, IAR).classification).toBe("unknown");
  });
  test("ext_shared ⇒ shared_external + mixed with foreign peers", () => {
    const r = classifySlackConversation({ is_ext_shared: true, context_team_id: "T0HOME", connected_team_ids: ["T0HOME", "T0PEER"] }, IAR);
    expect(r).toMatchObject({ classification: "shared_external", mixed: true, basis: "ext_shared", slackTeamId: "T0HOME", externalTeamIds: ["T0PEER"] });
  });
  test("pending ext share ⇒ shared_external", () => {
    expect(classifySlackConversation({ is_ext_shared: false, is_pending_ext_shared: true, context_team_id: "T0HOME" }, IAR)).toMatchObject({ classification: "shared_external", basis: "pending_ext_shared" });
  });
  test("foreign connected team even if not flagged ext ⇒ shared_external", () => {
    expect(classifySlackConversation({ is_ext_shared: false, context_team_id: "T0HOME", connected_team_ids: ["T0EVIL"] }, IAR).classification).toBe("shared_external");
  });
  test("org_shared among IAR teams ⇒ internal; with unregistered team ⇒ unknown", () => {
    expect(classifySlackConversation({ is_ext_shared: false, is_org_shared: true, is_shared: true, context_team_id: "T0HOME", connected_team_ids: ["T0SISTER"] }, IAR)).toMatchObject({ classification: "internal", basis: "org_shared_internal_teams" });
    expect(classifySlackConversation({ is_ext_shared: false, is_org_shared: true, context_team_id: "T0OTHER" }, IAR)).toMatchObject({ classification: "unknown", basis: "org_shared_unverified" });
  });
  test("unshared home team in IAR ⇒ internal; not in IAR ⇒ unknown", () => {
    expect(classifySlackConversation({ is_ext_shared: false, context_team_id: "T0HOME" }, IAR)).toMatchObject({ classification: "internal", mixed: false });
    expect(classifySlackConversation({ is_ext_shared: false, context_team_id: "T0STRANGER" }, IAR)).toMatchObject({ classification: "unknown", basis: "home_team_not_registered" });
    expect(classifySlackConversation({ is_ext_shared: false, context_team_id: "T0HOME" }, [])).toMatchObject({ classification: "unknown" });
  });
});

describe("mergeAutoClassification (stricter-only)", () => {
  const ext = { classification: "shared_external" as const, mixed: true, externalTeamIds: ["T0PEER"] };
  const intl = { classification: "internal" as const, mixed: false, externalTeamIds: [] };
  const unk = { classification: "unknown" as const, mixed: false, externalTeamIds: [] };

  test("new row takes the auto result", () => {
    expect(mergeAutoClassification(null, ext)).toMatchObject({ classification: "shared_external", mixed: true, changed: true });
  });
  test("shared → internal is rejected (no downgrade)", () => {
    const r = mergeAutoClassification({ classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"], humanConfirmedAt: null }, intl);
    expect(r).toMatchObject({ classification: "shared_external", mixed: true, changed: false, rejectedWidening: true });
  });
  test("internal mixed → internal is rejected", () => {
    const r = mergeAutoClassification({ classification: "internal", mixed: true, externalTeamIds: [], humanConfirmedAt: null }, intl);
    expect(r).toMatchObject({ mixed: true, rejectedWidening: true });
  });
  test("internal → shared is allowed even when human-confirmed (later shared)", () => {
    const r = mergeAutoClassification({ classification: "internal", mixed: false, externalTeamIds: [], humanConfirmedAt: "2026-10-01T00:00:00Z" }, ext);
    expect(r).toMatchObject({ classification: "shared_external", mixed: true, changed: true, externalTeamIds: ["T0PEER"] });
  });
  test("unknown (API failure) never overwrites", () => {
    expect(mergeAutoClassification({ classification: "internal", mixed: false, externalTeamIds: [], humanConfirmedAt: null }, unk)).toMatchObject({ classification: "internal", changed: false });
    expect(mergeAutoClassification({ classification: "shared_external", mixed: true, externalTeamIds: [], humanConfirmedAt: null }, unk)).toMatchObject({ classification: "shared_external", changed: false });
  });
  test("unknown → internal allowed for auto rows, rejected for human-confirmed rows", () => {
    expect(mergeAutoClassification({ classification: "unknown", mixed: false, externalTeamIds: [], humanConfirmedAt: null }, intl)).toMatchObject({ classification: "internal", changed: true });
    expect(mergeAutoClassification({ classification: "unknown", mixed: false, externalTeamIds: [], humanConfirmedAt: "x" }, intl)).toMatchObject({ classification: "unknown", rejectedWidening: true });
  });
  test("external team ids only grow", () => {
    const r = mergeAutoClassification({ classification: "shared_external", mixed: true, externalTeamIds: ["T0OLD"], humanConfirmedAt: null }, ext);
    expect(r.externalTeamIds.sort()).toEqual(["T0OLD", "T0PEER"]);
    expect(r.changed).toBe(true);
  });
});
