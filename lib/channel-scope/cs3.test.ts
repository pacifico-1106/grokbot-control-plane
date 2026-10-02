import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isChannelInScopeForPath, resolveEffectiveChannelScope } from "./resolve";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  evaluateChannelScope,
  getChannelScopeChannel,
  setOrgChannelScopePolicy,
  upsertAutoClassifiedChannel,
} from "./data";
import { defaultChannelScopePolicy } from "./validate";
import type { ChannelScopeChannel, ChannelScopeFlags } from "./types";
import { getOrgChannel, upsertOrgChannel } from "@/lib/data/directory";
import { DEMO_ORG } from "@/lib/demo-data";

const ON: ChannelScopeFlags = { enabled: true, connectEnabled: true };
const OFF: ChannelScopeFlags = { enabled: false, connectEnabled: false };
const ORG = DEMO_ORG.id;
const saved = process.env.P1_CHANNEL_SCOPE_ENABLED;
let n = 0;
const chan = () => `C0UNIT${Date.now().toString(36).toUpperCase()}${(n += 1)}`;

const ch = (p: Partial<ChannelScopeChannel>): ChannelScopeChannel => ({
  externalId: "C0X",
  classification: "internal",
  mixed: false,
  source: "manual",
  ...p,
});

describe("isChannelInScopeForPath", () => {
  const regOnly = resolveEffectiveChannelScope({ flags: ON });
  const allJoined = resolveEffectiveChannelScope({ orgPolicy: { version: 1, mode: "all_joined" }, flags: ON });
  const base = { surface: "slack", externalId: "C0X" } as const;

  test("flag OFF ⇒ not enforced on both paths", () => {
    const scope = resolveEffectiveChannelScope({ flags: OFF });
    for (const path of ["bot_channel", "user_token_channel"] as const) {
      expect(isChannelInScopeForPath({ ...base, scope, channel: null, path })).toMatchObject({ enforced: false, inScope: true });
    }
  });

  test("registered_only: user-token path is strict; bot path keeps legacy except auto-only rows", () => {
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: null, path: "user_token_channel" }).inScope).toBe(false);
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: null, path: "bot_channel" })).toMatchObject({ inScope: true, reason: "bot_path_legacy" });
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: ch({ classification: "unknown" }), path: "bot_channel" }).inScope).toBe(true);
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: ch({ source: "auto_join" }), path: "bot_channel" })).toMatchObject({ inScope: false, reason: "auto_not_confirmed" });
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: ch({ source: "auto_join", classification: "unknown" }), path: "bot_channel" }).inScope).toBe(false);
    expect(isChannelInScopeForPath({ ...base, scope: regOnly, channel: ch({ source: "auto_join", humanConfirmedAt: "2026-10-01T00:00:00Z" }), path: "bot_channel" }).inScope).toBe(true);
  });

  test("all_joined: bot path uses the full decision", () => {
    const left = [{ surface: "slack" as const, externalId: "C0X", state: "removed" as const, via: "bot" as const }];
    expect(isChannelInScopeForPath({ ...base, scope: allJoined, channel: ch({ source: "auto_join" }), memberships: left, path: "bot_channel" })).toMatchObject({ inScope: false, reason: "membership_left" });
    expect(isChannelInScopeForPath({ ...base, scope: allJoined, channel: null, path: "bot_channel" })).toMatchObject({ inScope: false, reason: "not_member" });
  });
});

describe("upsertAutoClassifiedChannel (demo)", () => {
  beforeEach(() => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    __resetChannelScopeDemoStore();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
  });

  test("throws when the flag is OFF and validates input", async () => {
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    const auto = { classification: "internal" as const, mixed: false, externalTeamIds: [] };
    await expect(upsertAutoClassifiedChannel({ orgId: ORG, externalId: chan(), auto, source: "auto_join" })).rejects.toThrow("channel_scope_disabled");
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    await expect(upsertAutoClassifiedChannel({ orgId: ORG, externalId: "D0DM", auto, source: "auto_join" })).rejects.toThrow("invalid_external_id");
    await expect(upsertAutoClassifiedChannel({ orgId: ORG, externalId: chan(), auto, source: "manual" as never })).rejects.toThrow("invalid_auto_source");
  });

  test("new row ⇒ auto source; repeated unknown never overwrites; shared is sticky", async () => {
    const c = chan();
    const first = await upsertAutoClassifiedChannel({
      orgId: ORG,
      externalId: c,
      auto: { classification: "internal", mixed: false, externalTeamIds: [], slackTeamId: "T0HOME" },
      source: "auto_join",
    });
    expect(first.created).toBe(true);
    expect(first.channel).toMatchObject({ classification: "internal", source: "auto_join", slackTeamId: "T0HOME" });
    const unknown = await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "unknown", mixed: false, externalTeamIds: [] }, source: "auto_join" });
    expect(unknown.channel.classification).toBe("internal");
    const shared = await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] }, source: "reconcile" });
    expect(shared.channel).toMatchObject({ classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"], source: "auto_join" });
    const back = await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "internal", mixed: false, externalTeamIds: [] }, source: "auto_join" });
    expect(back.merged.rejectedWidening).toBe(true);
    expect(back.channel.classification).toBe("shared_external");
    expect((await getOrgChannel(ORG, "slack", c))?.classification).toBe("shared_external");
  });

  test("manual rows keep source=manual; human confirmation is cleared only when the row becomes Connect", async () => {
    const c = chan();
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: c, classification: "internal", skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", c, { humanConfirmedAt: "2026-10-01T00:00:00.000Z" });
    const same = await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "internal", mixed: false, externalTeamIds: [] }, source: "auto_join" });
    expect(same.channel).toMatchObject({ source: "manual", humanConfirmedAt: "2026-10-01T00:00:00.000Z" });
    expect(same.confirmationCleared).toBe(false);
    const shared = await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "shared_external", mixed: true, externalTeamIds: ["T0PEER"] }, source: "auto_join" });
    expect(shared.confirmationCleared).toBe(true);
    expect(shared.channel).toMatchObject({ source: "manual", humanConfirmedAt: null, classification: "shared_external" });
  });
});

describe("evaluateChannelScope path option", () => {
  beforeEach(() => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
    __resetChannelScopeDemoStore();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    else process.env.P1_CHANNEL_SCOPE_ENABLED = saved;
  });

  test("bot_channel legacy vs user_token_channel strict under registered_only", async () => {
    const c = chan();
    const args = { orgId: ORG, employeeId: "emp_comm", surface: "slack" as const, externalId: c };
    expect((await evaluateChannelScope({ ...args, path: "bot_channel" })).inScope).toBe(true);
    expect((await evaluateChannelScope({ ...args, path: "user_token_channel" })).inScope).toBe(false);
    expect((await evaluateChannelScope(args)).inScope).toBe(false);
  });

  test("all_joined uses memberships on both paths", async () => {
    await setOrgChannelScopePolicy(ORG, { ...defaultChannelScopePolicy(), mode: "all_joined" });
    const c = chan();
    await upsertAutoClassifiedChannel({ orgId: ORG, externalId: c, auto: { classification: "internal", mixed: false, externalTeamIds: [] }, source: "auto_join" });
    expect(await getChannelScopeChannel(ORG, "slack", c)).toMatchObject({ source: "auto_join" });
    const args = { orgId: ORG, employeeId: "emp_comm", surface: "slack" as const, externalId: c };
    expect((await evaluateChannelScope({ ...args, path: "bot_channel" })).reason).toBe("not_member");
  });
});
