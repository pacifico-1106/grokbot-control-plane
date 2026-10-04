/**
 * Invite activation (木村 2026-10-04 #1): claimPendingInvite only ever sends the
 * server-verified Auth user id to the DB claim RPC (never an email, never
 * anything from the client), is OFF unless MEMBER_INVITE_ACTIVATION_ENABLED,
 * and fails closed (no access) on any DB error.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type Rpc = { fn: string; args: Record<string, unknown> };
let rpcCalls: Rpc[] = [];
let rpcResult: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };
let rpcThrows = false;

mock.module("../mode", () => ({ isDemoMode: () => false }));
mock.module("../supabase", () => ({
  createSupabaseAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcThrows) throw new Error("network down");
      return rpcResult;
    },
  }),
}));

const FLAG = "MEMBER_INVITE_ACTIVATION_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => {
  rpcCalls = [];
  rpcThrows = false;
  rpcResult = { data: null, error: null };
  process.env[FLAG] = "true";
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const load = () => import("./invite-claim");

test("flag OFF (default): no DB call, status disabled", async () => {
  delete process.env[FLAG];
  const { claimPendingInvite } = await load();
  expect(await claimPendingInvite("u_1")).toEqual({ status: "disabled" });
  expect(rpcCalls).toEqual([]);
  const { isMemberInviteActivationEnabled } = await import("../feature-flags");
  expect(isMemberInviteActivationEnabled()).toBe(false);
});

test("flag ON: calls claim_member_invites with the user id only (no email argument)", async () => {
  rpcResult = {
    data: { status: "claimed", member_id: "m_1", org_id: "o_1" },
    error: null,
  };
  const { claimPendingInvite } = await load();
  expect(await claimPendingInvite("u_1")).toEqual({ status: "claimed", memberId: "m_1", orgId: "o_1" });
  expect(rpcCalls).toEqual([{ fn: "claim_member_invites", args: { p_user_id: "u_1" } }]);
});

test("no pending / ineligible → none with the DB reason", async () => {
  rpcResult = { data: { status: "none", reason: "no_pending_invite" }, error: null };
  const { claimPendingInvite } = await load();
  expect(await claimPendingInvite("u_1")).toEqual({ status: "none", reason: "no_pending_invite" });
});

test("missing user id → none, no DB call", async () => {
  const { claimPendingInvite } = await load();
  expect(await claimPendingInvite(null)).toEqual({ status: "none", reason: "not_eligible" });
  expect(rpcCalls).toEqual([]);
});

test("DB error / malformed result / throw → error (fail closed, no access)", async () => {
  const { claimPendingInvite } = await load();
  rpcResult = { data: null, error: { message: "permission denied", code: "42501" } };
  expect((await claimPendingInvite("u_1")).status).toBe("error");
  rpcResult = { data: { status: "claimed" }, error: null };
  expect((await claimPendingInvite("u_1")).status).toBe("error");
  rpcThrows = true;
  expect((await claimPendingInvite("u_1")).status).toBe("error");
});
