import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "../demo-data";
import {
  __resetChannelScopeDemoStore,
  __setDemoChannelScopeMeta,
  __setDemoRawPolicies,
  evaluateChannelScope,
  getEffectiveChannelScope,
  listEmployeeChannelMemberships,
  setEmployeeChannelScopeOverride,
  setOrgChannelScopePolicy,
  upsertEmployeeChannelMembership,
} from "./data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { defaultChannelScopePolicy } from "./validate";
import type { ChannelScopePolicy } from "./types";

const ORG = DEMO_ORG.id;
const EMP = "emp_cs1_test";
const saved = { a: process.env.P1_CHANNEL_SCOPE_ENABLED, b: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED };

function restore() {
  if (saved.a === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED; else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.a;
  if (saved.b === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED; else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = saved.b;
}

const allJoined = (includeSlackConnect = false): ChannelScopePolicy => ({
  ...defaultChannelScopePolicy(),
  mode: "all_joined",
  includeSlackConnect,
});

beforeEach(() => {
  __resetChannelScopeDemoStore();
  delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
});
afterEach(restore);

describe("flag OFF (default) is inert", () => {
  test("effective scope is registered_only and evaluate is not enforced", async () => {
    __setDemoRawPolicies(ORG, { org: allJoined(true) });
    const s = await getEffectiveChannelScope(ORG, EMP);
    expect(s.policy.mode).toBe("registered_only");
    expect(s.flags.enabled).toBe(false);
    const d = await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C_UNREGISTERED" });
    expect(d).toMatchObject({ enforced: false, reason: "flag_off_legacy" });
  });

  test("writes are refused", async () => {
    await expect(setOrgChannelScopePolicy(ORG, allJoined())).rejects.toThrow("channel_scope_disabled");
    await expect(setEmployeeChannelScopeOverride(ORG, EMP, allJoined())).rejects.toThrow("channel_scope_disabled");
    await expect(
      upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0AAA", via: "user", state: "member" })
    ).rejects.toThrow("channel_scope_disabled");
  });
});

describe("flag ON", () => {
  beforeEach(() => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  });

  test("resolution order employee > org > default", async () => {
    expect((await getEffectiveChannelScope(ORG, EMP)).source).toBe("default");
    await setOrgChannelScopePolicy(ORG, allJoined());
    expect(await getEffectiveChannelScope(ORG, EMP)).toMatchObject({ source: "org", policy: { mode: "all_joined" } });
    await setEmployeeChannelScopeOverride(ORG, EMP, defaultChannelScopePolicy());
    expect(await getEffectiveChannelScope(ORG, EMP)).toMatchObject({ source: "employee", policy: { mode: "registered_only" } });
    await setEmployeeChannelScopeOverride(ORG, EMP, null);
    expect((await getEffectiveChannelScope(ORG, EMP)).source).toBe("org");
    expect((await getEffectiveChannelScope(ORG)).source).toBe("org");
  });

  test("policy writes are validated", async () => {
    const bad = { ...defaultChannelScopePolicy(), includeSlackConnect: true };
    await expect(setOrgChannelScopePolicy(ORG, bad)).rejects.toThrow("invalid_channel_scope_policy");
  });

  test("invalid stored JSON resolves to the safe default", async () => {
    __setDemoRawPolicies(ORG, { org: allJoined(true), employeeId: EMP, employee: { mode: "everything" } });
    const s = await getEffectiveChannelScope(ORG, EMP);
    expect(s.policy.mode).toBe("registered_only");
    expect(s.invalidStoredPolicy).toBe(true);
  });

  test("registered_only: demo manual channel in, unregistered out", async () => {
    expect(await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C_INTERNAL" })).toMatchObject({ enforced: true, inScope: true, reason: "registered" });
    expect(await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0NOPE" })).toMatchObject({ enforced: true, inScope: false, reason: "not_registered" });
  });

  test("all_joined: membership drives scope; left ⇒ out", async () => {
    await setOrgChannelScopePolicy(ORG, allJoined());
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0AUTO1", classification: "internal", skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", "C0AUTO1", { source: "auto_join" });
    expect((await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0AUTO1" })).reason).toBe("not_member");
    const first = await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0AUTO1", via: "user", state: "member", eventId: "Ev1", inviterTeamId: "T0HOME" });
    expect(first.applied).toBe(true);
    expect(first.membership.joinedAt).not.toBeNull();
    expect((await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0AUTO1" })).reason).toBe("joined_internal");
    const left = await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0AUTO1", via: "user", state: "left", eventId: "Ev2" });
    expect(left.membership.leftAt).not.toBeNull();
    expect((await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0AUTO1" })).reason).toBe("membership_left");
  });

  test("all_joined + Connect requires both the policy boolean and the Connect flag", async () => {
    await setOrgChannelScopePolicy(ORG, allJoined(true));
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: "C0CONN1", classification: "shared_external", mixed: true, skipInspect: true });
    __setDemoChannelScopeMeta(ORG, "slack", "C0CONN1", { source: "auto_join", externalTeamIds: ["T0PEER"] });
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0CONN1", via: "user", state: "member" });
    expect((await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0CONN1" })).reason).toBe("connect_not_included");
    process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = "1";
    expect((await evaluateChannelScope({ orgId: ORG, employeeId: EMP, surface: "slack", externalId: "C0CONN1" })).reason).toBe("joined_connect");
  });

  test("membership upsert is idempotent per event id and unique per (employee, channel, via)", async () => {
    const a = await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0IDEM", via: "bot", state: "member", eventId: "EvSame" });
    const b = await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0IDEM", via: "bot", state: "left", eventId: "EvSame" });
    expect(b.applied).toBe(false);
    expect(b.membership.state).toBe("member");
    expect(b.membership.id).toBe(a.membership.id);
    await upsertEmployeeChannelMembership({ orgId: ORG, employeeId: EMP, externalId: "C0IDEM", via: "user", state: "member" });
    const rows = await listEmployeeChannelMemberships(ORG, { employeeId: EMP, externalId: "C0IDEM" });
    expect(rows).toHaveLength(2);
    expect(await listEmployeeChannelMemberships("other-org", { employeeId: EMP })).toHaveLength(0);
  });

  const badInputs: [Record<string, unknown>, string][] = [
    [{ externalId: "c0lower" }, "invalid_external_id"],
    [{ externalId: "D0DMNOPE" }, "invalid_external_id"],
    [{ externalId: "C0AAA'; drop table x;--" }, "invalid_external_id"],
    [{ via: "admin" }, "invalid_via"],
    [{ state: "joined" }, "invalid_membership_state"],
    [{ inviterSlackUserId: "not-a-user" }, "invalid_inviter_user_id"],
    [{ inviterTeamId: "X1" }, "invalid_inviter_team_id"],
    [{ eventId: "bad event id with spaces" }, "invalid_event_id"],
  ];
  for (const [over, code] of badInputs) {
    test(`membership input ${JSON.stringify(over)} rejected (${code})`, async () => {
      const input = { orgId: ORG, employeeId: EMP, externalId: "C0AAA", via: "user", state: "member", ...over } as Parameters<typeof upsertEmployeeChannelMembership>[0];
      await expect(upsertEmployeeChannelMembership(input)).rejects.toThrow(code);
    });
  }

  test("list rejects bad state and caps limit", async () => {
    await expect(listEmployeeChannelMemberships(ORG, { state: "bogus" as never })).rejects.toThrow("invalid_membership_state");
    expect(await listEmployeeChannelMemberships(ORG, { limit: 100000 })).toEqual([]);
  });
});
