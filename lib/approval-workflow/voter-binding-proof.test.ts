/**
 * Proof-verified voter bindings (LINE link code, G1/G4).
 * A binding created from a redeemed link code is active immediately, but it
 * must never silently re-point an existing active binding to another member.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OrgMember } from "@/lib/types";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";
const members = new Map<string, OrgMember>();
const member = (id: string, orgId = ORG, status: OrgMember["status"] = "active"): OrgMember => ({
  id, orgId, email: `${id}@example.com`, displayName: id, role: "admin",
  capabilities: ["approve_actions"], status, jobRole: "admin_affairs",
});

mock.module("@/lib/demo-data", () => ({
  getRuntimeMemberById: (id: string) => members.get(id) ?? null,
}));

const { upsertProofVerifiedVoterBinding, getVoterBinding, revokeVoterBinding, resetDemoVoterBindings } =
  await import("./voter-binding");
const { getMemberIdFromVoterBinding } = await import("./data");

const input = (memberId: string, externalUserId = "U-line-1") => ({
  orgId: ORG, provider: "line" as const, channelKey: "chn-line", externalUserId, memberId,
});

beforeEach(() => {
  members.clear();
  resetDemoVoterBindings();
  members.set("mem-a", member("mem-a"));
  members.set("mem-b", member("mem-b"));
  members.set("mem-x", member("mem-x", OTHER_ORG));
  members.set("mem-off", member("mem-off", ORG, "disabled"));
});

describe("upsertProofVerifiedVoterBinding", () => {
  test("creates an active, verified binding usable for workflow voting", async () => {
    const res = await upsertProofVerifiedVoterBinding(input("mem-a"));
    expect(res.ok).toBe(true);
    const binding = await getVoterBinding(ORG, "line", "chn-line", "U-line-1");
    expect(binding?.status).toBe("active");
    expect(binding?.memberId).toBe("mem-a");
    expect(await getMemberIdFromVoterBinding(ORG, { provider: "line", channelKey: "chn-line", userId: "U-line-1" })).toBe("mem-a");
  });

  test("re-linking the same member is idempotent", async () => {
    expect((await upsertProofVerifiedVoterBinding(input("mem-a"))).ok).toBe(true);
    expect((await upsertProofVerifiedVoterBinding(input("mem-a"))).ok).toBe(true);
  });

  test("refuses to re-point an active binding to a different member (fail-closed)", async () => {
    await upsertProofVerifiedVoterBinding(input("mem-a"));
    const res = await upsertProofVerifiedVoterBinding(input("mem-b"));
    expect(res).toMatchObject({ ok: false, reason: "bound_to_other_member" });
    expect((await getVoterBinding(ORG, "line", "chn-line", "U-line-1"))?.memberId).toBe("mem-a");
  });

  test("a revoked binding can be replaced by a new proof", async () => {
    await upsertProofVerifiedVoterBinding(input("mem-a"));
    await revokeVoterBinding(ORG, "line", "chn-line", "U-line-1");
    const res = await upsertProofVerifiedVoterBinding(input("mem-b"));
    expect(res.ok).toBe(true);
    expect((await getVoterBinding(ORG, "line", "chn-line", "U-line-1"))?.status).toBe("active");
    expect(await getMemberIdFromVoterBinding(ORG, { provider: "line", channelKey: "chn-line", userId: "U-line-1" })).toBe("mem-b");
  });

  test("rejects members outside the org or inactive members", async () => {
    expect((await upsertProofVerifiedVoterBinding(input("mem-x"))).ok).toBe(false);
    expect((await upsertProofVerifiedVoterBinding(input("mem-off"))).ok).toBe(false);
    expect((await upsertProofVerifiedVoterBinding(input("mem-missing"))).ok).toBe(false);
  });

  test("bindings are scoped per channel: another channel key is unaffected", async () => {
    await upsertProofVerifiedVoterBinding(input("mem-a"));
    expect(await getMemberIdFromVoterBinding(ORG, { provider: "line", channelKey: "chn-other", userId: "U-line-1" })).toBeNull();
    expect(await getMemberIdFromVoterBinding(OTHER_ORG, { provider: "line", channelKey: "chn-line", userId: "U-line-1" })).toBeNull();
  });
});
