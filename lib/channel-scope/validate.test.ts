import { describe, expect, test } from "bun:test";
import {
  applyChannelScopePatch,
  defaultChannelScopePolicy,
  MAX_ALLOWED_EXTERNAL_TEAM_IDS,
  validateChannelScopePolicy,
} from "./validate";

describe("validateChannelScopePolicy", () => {
  test("default policy is registered_only without Connect", () => {
    const p = defaultChannelScopePolicy();
    expect(p.mode).toBe("registered_only");
    expect(p.includeSlackConnect).toBe(false);
    expect(p.connect.egress).toBe("needs_approval_until_confirmed");
    expect(p.connect.notifyApproverOnInvite).toBe(true);
    expect(p.connect.allowedExternalTeamIds).toEqual([]);
    expect(validateChannelScopePolicy(p).ok).toBe(true);
  });

  test("fills safe defaults for minimal policy", () => {
    const r = validateChannelScopePolicy({ mode: "all_joined" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy).toEqual({
      version: 1,
      mode: "all_joined",
      includeSlackConnect: false,
      surfaces: ["slack"],
      connect: { egress: "needs_approval_until_confirmed", notifyApproverOnInvite: true, allowedExternalTeamIds: [] },
    });
  });

  test("accepts all_joined + includeSlackConnect", () => {
    const r = validateChannelScopePolicy({ version: 1, mode: "all_joined", includeSlackConnect: true });
    expect(r.ok).toBe(true);
  });

  test("rejects includeSlackConnect with registered_only", () => {
    const r = validateChannelScopePolicy({ mode: "registered_only", includeSlackConnect: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain("connect_requires_all_joined");
  });

  const rejectCases: [unknown, string][] = [
    [null, "invalid_input"],
    [[], "invalid_input"],
    ["all_joined", "invalid_input"],
    [{}, "invalid_mode"],
    [{ mode: "everything" }, "invalid_mode"],
    [{ mode: "all_joined", version: 2 }, "unsupported_version"],
    [{ mode: "all_joined", includeSlackConnect: "true" }, "invalid_type"],
    [{ mode: "all_joined", surfaces: ["line"] }, "invalid_surfaces"],
    [{ mode: "all_joined", surfaces: [] }, "invalid_surfaces"],
    [{ mode: "all_joined", extra: 1 }, "unknown_field"],
    [{ mode: "all_joined", connect: "x" }, "invalid_type"],
    [{ mode: "all_joined", connect: { egress: "allow" } }, "invalid_value"],
    [{ mode: "all_joined", connect: { notifyApproverOnInvite: 1 } }, "invalid_type"],
    [{ mode: "all_joined", connect: { bogus: true } }, "unknown_field"],
    [{ mode: "all_joined", connect: { allowedExternalTeamIds: "T123" } }, "invalid_type"],
    [{ mode: "all_joined", connect: { allowedExternalTeamIds: ["U123"] } }, "invalid_team_id"],
    [{ mode: "all_joined", connect: { allowedExternalTeamIds: ["T1"] } }, "invalid_team_id"],
    [{ mode: "all_joined", connect: { allowedExternalTeamIds: [123] } }, "invalid_team_id"],
    [{ mode: "all_joined", updatedAt: "not a date" }, "invalid_type"],
    [{ mode: "all_joined", updatedBy: "x".repeat(201) }, "invalid_type"],
  ];
  for (const [input, code] of rejectCases) {
    test(`rejects ${JSON.stringify(input)?.slice(0, 80)} (${code})`, () => {
      const r = validateChannelScopePolicy(input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.map((e) => e.code)).toContain(code);
    });
  }

  test("teamId format: normalizes case, dedupes, accepts T… and E…", () => {
    const r = validateChannelScopePolicy({
      mode: "all_joined",
      includeSlackConnect: true,
      connect: { allowedExternalTeamIds: [" t0abc ", "T0ABC", "E0GRID"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.connect.allowedExternalTeamIds).toEqual(["T0ABC", "E0GRID"]);
  });

  test(`allowedExternalTeamIds upper bound ${MAX_ALLOWED_EXTERNAL_TEAM_IDS}`, () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `T${String(i).padStart(4, "0")}`);
    expect(validateChannelScopePolicy({ mode: "all_joined", connect: { allowedExternalTeamIds: ids(100) } }).ok).toBe(true);
    const r = validateChannelScopePolicy({ mode: "all_joined", connect: { allowedExternalTeamIds: ids(101) } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].code).toBe("too_many");
  });

  test("keeps updatedAt / updatedBy", () => {
    const r = validateChannelScopePolicy({ mode: "registered_only", updatedAt: "2026-10-02T00:00:00Z", updatedBy: "approval:abc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.updatedBy).toBe("approval:abc");
  });

  test("errors carry Japanese messages", () => {
    const r = validateChannelScopePolicy({ mode: "x" });
    if (r.ok) throw new Error("expected error");
    expect(r.errors[0].messageJa.length).toBeGreaterThan(0);
  });
});

describe("applyChannelScopePatch", () => {
  test("patch from default", () => {
    const r = applyChannelScopePatch(null, { mode: "all_joined", includeSlackConnect: true, connect: { allowedExternalTeamIds: ["T0PEER"] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.mode).toBe("all_joined");
    expect(r.policy.includeSlackConnect).toBe(true);
    expect(r.policy.connect).toEqual({ egress: "needs_approval_until_confirmed", notifyApproverOnInvite: true, allowedExternalTeamIds: ["T0PEER"] });
  });

  test("connect merges field-by-field; omitted includeSlackConnect resets to false", () => {
    const cur = applyChannelScopePatch(null, { mode: "all_joined", includeSlackConnect: true, connect: { notifyApproverOnInvite: false } });
    if (!cur.ok) throw new Error("setup");
    const r = applyChannelScopePatch(cur.policy, { mode: "all_joined", connect: { egress: "matrix" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.includeSlackConnect).toBe(false);
    expect(r.policy.connect.notifyApproverOnInvite).toBe(false);
    expect(r.policy.connect.egress).toBe("matrix");
  });

  test("rejects unknown patch fields and Connect without all_joined", () => {
    expect(applyChannelScopePatch(null, { mode: "all_joined", surfaces: ["slack"] }).ok).toBe(false);
    expect(applyChannelScopePatch(null, { mode: "registered_only", includeSlackConnect: true }).ok).toBe(false);
    expect(applyChannelScopePatch(null, { includeSlackConnect: false }).ok).toBe(false);
    expect(applyChannelScopePatch(null, null).ok).toBe(false);
    expect(applyChannelScopePatch(null, { mode: "all_joined", connect: [] }).ok).toBe(false);
  });
});
