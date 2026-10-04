/**
 * /api/auth/repair-org with invite activation: an invited Auth user without an
 * active membership has the pending invite bound and goes to /app instead of
 * /auth/no-access. Never provisions an org for invited users.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let claimStatus: "claimed" | "none" = "claimed";
let claimCalls = 0;
let provisionCalls = 0;
let bound = false;

const baseSession = { demo: false, userId: "u_invited", email: "invitee@fixture.invalid", invited: true };
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () =>
    bound
      ? { ...baseSession, orgId: "o_inviter", member: { id: "m_1", orgId: "o_inviter", status: "active" } }
      : { ...baseSession, orgId: null, member: null },
  isInvitedWithoutMembership: (s: { userId: string | null; invited?: boolean; orgId: string | null }) =>
    Boolean(s.userId && s.invited && !s.orgId),
  activatePendingInvite: async (s: { userId: string | null; invited?: boolean }) => {
    claimCalls++;
    if (process.env.MEMBER_INVITE_ACTIVATION_ENABLED !== "true" || !s.invited) return null;
    if (claimStatus !== "claimed") return null;
    bound = true;
    return { ...baseSession, orgId: "o_inviter", member: { id: "m_1", orgId: "o_inviter", status: "active" } };
  },
  provisionOrgForUser: async () => {
    provisionCalls++;
    return { orgId: "o_new", memberId: "m_new", member: {} };
  },
}));

const FLAG = "MEMBER_INVITE_ACTIVATION_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  claimStatus = "claimed";
  claimCalls = 0;
  provisionCalls = 0;
  bound = false;
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const { POST } = await import("./route");
const req = () => new Request("https://fixture.invalid/api/auth/repair-org", { method: "POST" });

test("invited user with a matching pending invite → bound → /app (no org provisioned)", async () => {
  const res = await POST(req());
  expect(res.status).toBe(303);
  expect(new URL(res.headers.get("location")!).pathname).toBe("/app");
  expect(claimCalls).toBe(1);
  expect(provisionCalls).toBe(0);
});

test("invited user with nothing to claim → /auth/no-access (no org provisioned)", async () => {
  claimStatus = "none";
  const res = await POST(req());
  expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/no-access");
  expect(provisionCalls).toBe(0);
});
